from __future__ import annotations

import json
import gzip
import math
from pathlib import Path
import re
from threading import Lock
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, Request, Response, UploadFile
import pandas as pd
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app.api.dependencies import require_admin, require_roles
from app.core.database import get_db
from app.models.enums import UserRole
from app.services import price_comparison_core as core
from app.services import price_comparison_exports as exports
from app.services.price_comparison_service import (
    PriceComparisonService, filter_frame, references_to_core,
)
from app.services.price_comparison_storage import (
    MAX_BATCH_BYTES, MAX_FILE_BYTES, get_price_storage, graph_errors, snapshot,
)

router = APIRouter(prefix="/price-comparison", tags=["price-comparison"],
    dependencies=[Depends(require_roles(UserRole.ADMIN, UserRole.PROJECT_MANAGER))])
PDF_EXPORT_LOCK = Lock()


def price_service():
    with graph_errors():
        yield PriceComparisonService(get_price_storage())


Service = Annotated[PriceComparisonService, Depends(price_service)]
Database = Annotated[Session, Depends(get_db)]
Revision = Annotated[str, Field(min_length=64, max_length=64, pattern=r"^[a-f0-9]+$")]
Offset = Annotated[int, Query(ge=0, le=1_000_000)]
Limit = Annotated[int, Query(ge=1, le=500)]
Search = Annotated[str, Query(max_length=300)]
PriceLevel = Annotated[Literal["all", "below", "above", "none"], Query()]
OfferSort = Annotated[Literal["date", "price_asc", "price_desc"], Query()]


class Payload(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Reference(Payload):
    article_number: str = Field(min_length=1, max_length=50)
    weight: float = Field(gt=0, le=1_000_000, allow_inf_nan=False)


class SuggestionQuery(Payload):
    references: list[Reference] = Field(default_factory=list, max_length=500)
    search: str = Field(default="", max_length=300)
    cluster: str = Field(default="", max_length=150)
    offset: int = Field(default=0, ge=0, le=1_000_000)
    limit: int = Field(default=100, ge=1, le=500)


class OfferPatch(Payload):
    expected_revision: Revision
    offer_type: Literal["Erstangebot", "Folgeangebot", "Verhandeltes Angebot"] | None = None
    discount: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    align_netto: bool | None = None
    manual_prices: dict[str, float | None] | None = None
    delete_articles: list[str] | None = Field(default=None, max_length=5000)
    reset_manual_prices: bool = False

    @field_validator("manual_prices")
    @classmethod
    def valid_prices(cls, value):
        if value and (len(value) > 5000 or any(
            len(k) > 50 or (v is not None and (not math.isfinite(v) or v < 0))
            for k, v in value.items()
        )):
            raise ValueError("Ungültige manuelle Preise.")
        return value


class Preset(Payload):
    expected_revision: Revision
    references: list[Reference] = Field(min_length=1, max_length=500)


class Maintenance(Payload):
    expected_revision: Revision
    action: Literal["rebuild_offers", "reparse_datanorm", "refresh_percentages"]
    confirmed_duplicates: list[str] = Field(default_factory=list, max_length=2000)


class ExportRequest(Payload):
    kind: Literal["datanorm", "suggestions", "offer", "offer_pdf", "offer_ugl", "article", "article_pdf"]
    source: str | None = Field(default=None, max_length=220)
    article_number: str | None = Field(default=None, max_length=50)
    search: str = Field(default="", max_length=300)
    cluster: str = Field(default="", max_length=150)
    references: list[Reference] = Field(default_factory=list, max_length=500)
    offer_types: list[Literal["Erstangebot", "Folgeangebot", "Verhandeltes Angebot"]] | None = None


@router.get("/status")
def status(service: Service):
    return service.status()


@router.get("/datanorm")
def datanorm(service: Service, search: Search = "", cluster: Search = "", offset: Offset = 0, limit: Limit = 100):
    return service.datanorm(search=search, cluster=cluster, offset=offset, limit=limit)


@router.post("/suggestions/preview")
def suggestions(payload: SuggestionQuery, service: Service):
    return service.suggestions(**payload.model_dump())


@router.get("/reference-presets")
def presets(service: Service):
    return service.presets()


@router.put("/reference-presets/{name}")
def save_preset(name: str, payload: Preset, service: Service, db: Database):
    return service.update_preset(name, [r.model_dump() for r in payload.references], payload.expected_revision, db)


@router.delete("/reference-presets/{name}")
def delete_preset(name: str, expected_revision: str, service: Service, db: Database):
    return service.update_preset(name, None, expected_revision, db)


@router.get("/offers")
def offers(
    service: Service,
    search: Search = "",
    offer_type: Search = "",
    price_level: PriceLevel = "all",
    sort: OfferSort = "date",
    offset: Offset = 0,
    limit: Limit = 20,
):
    return service.offers(
        search=search, offer_type=offer_type, price_level=price_level, sort=sort,
        offset=offset, limit=limit,
    )


@router.get("/offers/{source}/positions")
def positions(source: str, service: Service):
    return service.positions(source)


@router.patch("/offers/{source}")
def update_offer(source: str, payload: OfferPatch, service: Service, db: Database):
    patch = payload.model_dump(exclude={"expected_revision"}, exclude_unset=True, exclude_none=True)
    return service.update_offer(source, patch, payload.expected_revision, db)


@router.get("/articles")
def articles(service: Service, search: Search = "", limit: Limit = 50):
    return service.articles(search=search, limit=limit)


@router.get("/article-search-index")
def article_search_index(service: Service, request: Request, known_revision: Search = ""):
    payload = json.dumps(service.article_search_index(known_revision), ensure_ascii=False,
                         allow_nan=False, separators=(",", ":")).encode("utf-8")
    headers = {"Cache-Control": "private, no-store", "Vary": "Accept-Encoding"}
    # Avoid FastAPI recursively copying thousands of already JSON-safe rows.
    # Compression is scoped to this large index, not unrelated calendar APIs.
    encodings = {}
    for encoding in request.headers.get("accept-encoding", "").split(","):
        name, *parameters = encoding.strip().lower().split(";")
        try:
            encodings[name] = next((float(p.strip()[2:]) for p in parameters if p.strip().startswith("q=")), 1.0)
        except ValueError:
            encodings[name] = 0.0
    if len(payload) >= 1024 and encodings.get("gzip", encodings.get("*", 0)) > 0:
        payload = gzip.compress(payload, compresslevel=1, mtime=0)
        headers["Content-Encoding"] = "gzip"
    return Response(payload, media_type="application/json", headers=headers)


@router.get("/articles/{article_number}")
def article(article_number: str, service: Service, offer_types: Annotated[list[str] | None, Query()] = None):
    return service.article(article_number, offer_types=offer_types)


@router.get("/files")
def files(service: Service):
    return service.files()


@router.post("/files")
def upload_files(service: Service, db: Database, kind: Annotated[str, Form()],
                 expected_revision: Annotated[str, Form()], files: Annotated[list[UploadFile], File()],
                 confirmed_duplicates: Annotated[str, Form()] = "[]"):
    if not files or len(files) > 200:
        raise HTTPException(422, "Bitte 1 bis 200 Dateien auswählen.")
    uploads, size = [], 0
    for file in files:
        raw = file.file.read(MAX_FILE_BYTES + 1)
        size += len(raw)
        if len(raw) > MAX_FILE_BYTES or size > MAX_BATCH_BYTES:
            raise HTTPException(413, "Maximal 40 MB je Datei und 160 MB je Upload.")
        uploads.append((file.filename or "", raw))
    if len({name.casefold() for name, _ in uploads}) != len(uploads):
        raise HTTPException(422, "Ein Upload darf jeden Dateinamen nur einmal enthalten.")
    try:
        confirmed = json.loads(confirmed_duplicates)
        if not isinstance(confirmed, list) or len(confirmed) > 2000 or any(not isinstance(n, str) for n in confirmed):
            raise ValueError("invalid confirmation")
    except ValueError as exc:
        raise HTTPException(422, "Ungültige Dateibestätigung.") from exc
    return service.upload(kind, uploads, expected_revision, db, confirmed_duplicates=confirmed)


@router.delete("/files/{kind}/{name}")
def delete_file(kind: Literal["offers", "datanorm"], name: str, expected_revision: str, service: Service, db: Database):
    return service.delete_file(kind, name, expected_revision, db)


def download(raw, name, mime):
    return Response(raw, media_type=mime, headers={
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(name, safe=""),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    })


def _strip_emoji_for_excel(value: object) -> str:
    """Keep the original Windows-compatible offer workbook headings."""

    text = "" if value is None else str(value)
    text = re.sub(r"[\U0001F000-\U0001FAFF]", "", text)
    text = re.sub(r"[\u2600-\u27BF]", "", text)
    text = text.replace("\uFE0F", "")
    return re.sub(r"\s{2,}", " ", text).strip()


def _format_eur_de(value: object) -> str:
    try:
        formatted = f"{float(value):,.2f} €"
    except (TypeError, ValueError):
        return "—"
    return formatted.replace(",", "X").replace(".", ",").replace("X", ".")


def _offer_percent_bucket(value: float) -> str:
    if value >= 25.0:
        return "🟥"
    if value >= 10.0:
        return "🟧"
    if value > -10.0:
        return "🟨"
    if value > -25.0:
        return "🟩️"
    return "🟩🟩"


def _offer_excel_headings(offer: dict, gross_total: float | None) -> tuple[str, str]:
    """Rebuild the original expander heading used by the offer workbook."""

    date = pd.to_datetime(offer.get("date"), errors="coerce")
    date_text = date.strftime("%d.%m.%Y") if pd.notna(date) else "-"
    project = str(offer.get("project") or "—").strip() or "—"
    offer_number = str(offer.get("offer_number") or "—").strip() or "—"
    position_count = int(offer.get("position_count") or 0)

    header = (
        f"🗓 {date_text}  |  📌 {project}  |  # {offer_number}  |  "
        f"📦 {position_count} Pos."
    )
    type_badge = {
        "Erstangebot": "  |  Erstangebot",
        "Folgeangebot": "  |  Folgeangebot",
        "Verhandeltes Angebot": "  |  Verhandelt",
    }.get(str(offer.get("offer_type") or ""), "  |  Erstangebot")

    percent_parts = []
    for label, key in (
        ("Pos", "price_change_positions"),
        ("Projekt", "price_change"),
    ):
        value = offer.get(key)
        if value is None or pd.isna(value):
            continue
        number = float(value)
        sign = "+" if number >= 0 else ""
        percent_parts.append(
            f"{label} {sign}{number:.1f}% {_offer_percent_bucket(number)}".replace(".", ",")
        )

    parts = [header, type_badge]
    if percent_parts:
        parts.append("  |  📊 Ø Abw: " + " | ".join(percent_parts))

    total = offer.get("total_net")
    if total is None or pd.isna(total):
        total = gross_total
    parts.append(f"  |  💶 Gesamt {_format_eur_de(total)}")

    discount = float(offer.get("discount") or 0.0)
    if discount > 0:
        parts.append(f"  |  🔴 Rabatt {discount:.1f}%".replace(".", ","))

    title = _strip_emoji_for_excel(f"{project} | {offer_number}")
    subtitle = _strip_emoji_for_excel("".join(parts))
    return title, subtitle


def _article_pdf_chart_data(history: pd.DataFrame) -> pd.DataFrame:
    """Prepare the chart input exactly as the original article view did."""

    chart_data = history.dropna(subset=["Preis"]).copy()
    chart_data["Datum"] = pd.to_datetime(chart_data["Datum"], errors="coerce")
    chart_data = chart_data.dropna(subset=["Datum"]).copy()
    chart_data["Preis"] = pd.to_numeric(chart_data["Preis"], errors="coerce")
    chart_data = chart_data.dropna(subset=["Preis"]).copy()
    chart_data = chart_data.sort_values(
        ["Datum", "Quelle", "PDF_Order"], ascending=[False, True, True]
    ).reset_index(drop=True)
    chart_data["DatumLabel"] = chart_data["Datum"].dt.strftime("%m-%y")
    chart_data["PreisLabel"] = chart_data["Preis"].map(
        lambda value: _format_eur_de(value) if pd.notna(value) else ""
    )
    minimum = float(chart_data["Preis"].min()) if not chart_data.empty else 0.0
    chart_data["YMin"] = max(0.0, minimum * 0.50)
    chart_data["Pos"] = range(1, len(chart_data) + 1)
    chart_data["PosLabel"] = chart_data["Pos"].astype(str)
    return chart_data


def _article_description_lines(value: object) -> list[str]:
    raw_lines = [line.strip() for line in str(value or "").splitlines() if line.strip()]
    lines = [
        line
        for line in raw_lines
        if not line.startswith(("Mat.:", "Einheit:")) and line != "für Kabelleiter"
    ]
    if len(lines) >= 3:
        lines.pop(2)
    return lines


@router.get("/files/{kind}/{name}/download")
def download_file(kind: Literal["offers", "datanorm"], name: str, service: Service):
    snap = snapshot(service.store)
    config = snap.state.get("online_import")
    if (
        kind == "offers"
        and config is not None
        and name in config["virtual_sources"]
        and not any(item.kind == "offers" and item.name == name for item in snap.files)
    ):
        raise HTTPException(
            422,
            "Die Original-PDF war im Online-Preisviewer nicht mehr vorhanden.",
        )
    item = snap.find(kind, name)
    return download(service.store.read(item), name,
                    "application/pdf" if kind == "offers" else "application/octet-stream")


@router.post("/maintenance", dependencies=[Depends(require_admin)])
def maintenance(payload: Maintenance, service: Service, db: Database):
    if payload.action == "rebuild_offers":
        return service.rebuild(payload.expected_revision, payload.confirmed_duplicates, db)
    def apply(snap):
        if payload.action == "reparse_datanorm":
            choices = sorted((f for f in snap.files if f.kind == "datanorm"),
                             key=lambda f: (f.modified, f.name), reverse=True)
            if not choices:
                raise HTTPException(422, "Keine DATANORM-Datei vorhanden.")
            active = next((f for f in choices if f.name == snap.state["active_datanorm"]), choices[0])
            if snap.state.get("online_import") is not None:
                snap.state["online_import"]["datanorm_frame_active"] = False
            service.parsed(active, force=True)
            snap.state["active_datanorm"] = active.name
        service.refresh_metrics(snap)
    return service.mutate(payload.expected_revision, apply, db)


@router.post("/maintenance/preview", dependencies=[Depends(require_admin)])
def maintenance_preview(payload: Maintenance, service: Service):
    if payload.action != "rebuild_offers":
        raise HTTPException(422, "Eine Dublettenprüfung ist nur für den Angebots-Neuaufbau vorgesehen.")
    return service.rebuild_preview(payload.expected_revision)


@router.post("/exports")
def export(payload: ExportRequest, service: Service):
    data = service.load()
    if payload.kind in ("datanorm", "suggestions"):
        if payload.kind == "datanorm":
            frame = core.datanorm_comparison(data.datanorm, data.prices,
                data.snap.state["discounts"], data.snap.state["align_netto"])
            frame = filter_frame(frame, payload.search, payload.cluster)
            # Keep the original tab1_datanorm_view display/export schema;
            # cluster metadata is for filtering, not an extra export column.
            export_columns = ["Artikelnummer", "Bezeichnung", "Einheit", "Preis-Typ", "Nettopreis",
                              *[f"Angebotspreis {i}" for i in range(1, 6)]]
            raw = exports.datanorm_to_xlsx_bytes(frame.reindex(columns=export_columns))
            return download(raw, "baupreis_tab1_datanorm_vs_angebote.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        frame, meta = core.suggestions(data.datanorm, data.prices,
            references_to_core([r.model_dump() for r in payload.references]))
        frame = filter_frame(frame, payload.search, payload.cluster)
        excel_frame = frame.copy()
        excel_frame.insert(
            0,
            "Artikelvergleich",
            excel_frame["Artikelnummer"].astype(str).map(
                lambda article: (
                    f"?view=articles&article={quote(str(article).strip(), safe='')}"
                )
            ),
        )
        valid_references = meta.get("reference_articles_valid", [])
        reference_weight = meta.get("reference_weight_total")
        reference_deviation = meta.get("reference_deviation_pct")
        subtitle = (
            f"Referenzbasis: {len(valid_references)} verwertbare Referenzartikel"
            + (
                f", Gewichtung gesamt: {float(reference_weight):.2f}"
                if reference_weight is not None
                else ""
            )
            + (
                ", durchschnittliche Abweichung Median zu Nettopreis: "
                f"{float(reference_deviation):.1f}%."
                if reference_deviation is not None
                else "."
            )
        )
        raw, ext, mime = exports.dataframe_to_excel_download(
            excel_frame,
            "Nettopreisvorschlag",
            title="Nettopreisrechner",
            subtitle=subtitle,
        )
        return download(raw, "datanorm_nettopreis_vorschlaege" + ext, mime)
    if payload.kind.startswith("offer"):
        if not payload.source:
            raise HTTPException(422, "Bitte ein Angebot auswählen.")
        if payload.source not in {source.name for source in data.offer_sources}:
            raise HTTPException(404, "Angebot im Preisvergleich nicht gefunden.")
        offer = next((o for o in service.offers_list(data) if o["source"] == payload.source), None)
        if not offer:
            raise HTTPException(422, "Das Angebot enthält keine Preispositionen.")
        stem = Path(payload.source).stem
        if payload.kind == "offer_pdf":
            with PDF_EXPORT_LOCK:
                raw = exports.build_offer_compilation_pdf(payload.source, data.datanorm, data.prices)
            if not raw:
                raise HTTPException(422, "Kein Artikel hat mindestens drei Vergleichspreise in den letzten zwölf Monaten.")
            return download(raw, f"angebot_{stem}_vergleich.pdf", "application/pdf")
        excel_frame, pn_frame = core.offer_export_frames(payload.source, data.datanorm, data.raw_prices, data.snap.state)
        if payload.kind == "offer_ugl":
            raw, name, mime = exports.export_pn_ugl(pn_frame, pdf_source=None,
                projekt_text=offer["project"], angebot_ref=offer["offer_number"], datanorm_df=data.datanorm)
            return download(raw, name, mime)
        gross_total = None
        if "Gesamt (brutto)" in data.raw_prices.columns:
            source_rows = data.raw_prices[
                data.raw_prices["Quelle"].astype(str).eq(payload.source)
            ]
            gross_values = pd.to_numeric(source_rows["Gesamt (brutto)"], errors="coerce").dropna()
            if not gross_values.empty:
                gross_total = float(gross_values.max())
        title, subtitle = _offer_excel_headings(offer, gross_total)
        raw, ext, mime = exports.dataframe_to_excel_download(
            excel_frame,
            "Angebot",
            title=title,
            subtitle=subtitle,
        )
        return download(raw, f"angebot_{stem}{ext}", mime)
    if not payload.article_number:
        raise HTTPException(422, "Bitte einen Artikel auswählen.")
    art = core.clean_artnr(payload.article_number)
    history = core.article_history(art, data.prices, payload.offer_types)
    ap_view = core.article_export_frame(art, data.prices, payload.offer_types)
    if payload.kind == "article":
        return download(
            exports.article_offers_to_csv_bytes(ap_view),
            f"artikel_{art}_angebote.csv",
            "text/csv; charset=utf-8",
        )
    matching = data.datanorm[data.datanorm["Artikelnummer"].astype(str).eq(art)] if not data.datanorm.empty else data.datanorm
    row = matching.iloc[0].to_dict() if not matching.empty else {}
    history = history.reindex(columns=list(dict.fromkeys([*history.columns, "Preis", "Datum", "Quelle", "PDF_Order"])))
    chart_data = _article_pdf_chart_data(history)
    with PDF_EXPORT_LOCK:
        raw = exports.build_article_pdf_bytes(
            art,
            _article_description_lines(row.get("Bezeichnung", "")),
            str(row.get("Einheit", "")),
            ap_view,
            chart_data,
            row.get("Nettopreis"),
        )
    if not raw:
        raise HTTPException(422, "Für diesen Artikel konnte kein Vergleichs-PDF erstellt werden.")
    return download(raw, f"preisvergleich_{art}.pdf", "application/pdf")
