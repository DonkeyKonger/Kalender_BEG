"""ReportLab exports adapted from the original BEG price viewer.

The visual construction intentionally mirrors ``viewer.py`` and
``pdf_export.py``.  Request-specific page-header state lives in a closure so
concurrent API requests cannot overwrite one another.
"""

from __future__ import annotations

import io
import re
from pathlib import Path

import pandas as pd

try:
    from app.services.price_comparison_core import clean_artnr
except ImportError:

    def clean_artnr(value: object) -> str:
        normalized = re.sub(r"[^0-9A-Za-z]", "", str(value)).upper()
        return normalized.lstrip("0")


SOURCE_PROVENANCE = {
    "repository_commit": "4ed988fdb49a4db355d7c2361dbcf8e272ae563d",
    "article_pdf_source": "viewer.py:_build_article_pdf_bytes",
    "compilation_pdf_source": "pdf_export.py:_build_offer_compilation_pdf",
}

try:
    from reportlab.lib.pagesizes import A4 as _A4  # noqa: F401

    REPORTLAB_AVAILABLE = True
except Exception:
    REPORTLAB_AVAILABLE = False

try:
    import matplotlib

    # The original Streamlit deployment ran headlessly.  Make that implicit
    # production condition explicit so macOS API/test processes never select
    # the interactive Cocoa backend.
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as _plt  # noqa: F401

    MPL_AVAILABLE = True
except Exception:
    MPL_AVAILABLE = False


def _safe(value: object) -> str:
    if value is None:
        return "—"
    try:
        if isinstance(value, float) and pd.isna(value):
            return "—"
    except Exception:
        pass
    text = str(value).replace("\u00a0", " ").strip()
    if text == "":
        return "—"
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_article_pdf_bytes(
    art: str,
    bez_lines: list[str],
    einheit: str,
    ap_view: pd.DataFrame,
    chart_data: pd.DataFrame,
    dn_val: float | None,
    highlight_src: str | None = None,
) -> bytes | None:
    """Create the original single-article A4 comparison PDF."""

    if not (REPORTLAB_AVAILABLE and MPL_AVAILABLE):
        return None

    import matplotlib.pyplot as plt
    from reportlab.lib import colors as RL_COLORS
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Image, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    # Seitenlayout
    left = right = 16 * mm
    page_width, _ = A4
    content_width = page_width - left - right

    # Styles
    styles = getSampleStyleSheet()
    h1 = ParagraphStyle("H1", parent=styles["Heading1"], fontSize=16, leading=19, spaceAfter=6)
    h2 = ParagraphStyle("H2", parent=styles["BodyText"], fontSize=11, leading=14)
    cap = ParagraphStyle(
        "CAP",
        parent=styles["BodyText"],
        fontSize=9,
        leading=11,
        textColor=RL_COLORS.grey,
    )

    def _fmt_eur(value: object) -> str:
        try:
            number = float(value)
            return f"{number:,.2f} €".replace(",", "X").replace(".", ",").replace("X", ".")
        except Exception:
            return "—"

    # Dokument anlegen
    out = io.BytesIO()
    doc = SimpleDocTemplate(
        out,
        pagesize=A4,
        leftMargin=left,
        rightMargin=right,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
    )
    story = []

    # Kopf
    story.append(Paragraph(f"Preisvergleich – Artikel {art}", h1))
    if bez_lines:
        story.append(Paragraph(" – ".join([line for line in bez_lines if line][:2]), h2))
    if einheit:
        story.append(Paragraph(f"Einheit: {einheit}", cap))
    story.append(Spacer(1, 8))

    # Mini-Tabelle: Datanorm
    dn_table = Table(
        [["Datanorm-Preis", _fmt_eur(dn_val) if dn_val is not None else "—"]],
        colWidths=[content_width * 0.30, content_width * 0.70],
    )
    dn_table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), RL_COLORS.HexColor("#f0f2f7")),
                ("BOX", (0, 0), (-1, -1), 0.5, RL_COLORS.HexColor("#cfd3dc")),
                (
                    "INNERGRID",
                    (0, 0),
                    (-1, -1),
                    0.25,
                    RL_COLORS.HexColor("#cfd3dc"),
                ),
                ("FONTNAME", (0, 0), (0, 0), "Helvetica-Bold"),
                ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story.append(dn_table)
    story.append(Spacer(1, 10))

    # Angebote-Tabelle (Monat | Angebotspreis | Angebot)
    ap_view = ap_view.copy() if isinstance(ap_view, pd.DataFrame) else pd.DataFrame()
    columns = ["Monat", "Angebotspreis", "Angebot"]
    table_rows = [columns] + [
        [
            row.get("Monat"),
            _fmt_eur(row.get("Angebotspreis")),
            row.get("Angebot") if pd.notna(row.get("Angebot")) else "—",
        ]
        for _, row in ap_view.iterrows()
    ]
    table = Table(
        table_rows,
        colWidths=[content_width * 0.22, content_width * 0.22, content_width * 0.56],
        repeatRows=1,
    )
    table.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), RL_COLORS.HexColor("#444444")),
                ("TEXTCOLOR", (0, 0), (-1, 0), RL_COLORS.white),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("ALIGN", (1, 1), (1, -1), "RIGHT"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                (
                    "ROWBACKGROUNDS",
                    (0, 1),
                    (-1, -1),
                    [RL_COLORS.whitesmoke, RL_COLORS.HexColor("#f5f7fb")],
                ),
                ("GRID", (0, 0), (-1, -1), 0.25, RL_COLORS.HexColor("#cfd3dc")),
                ("LEFTPADDING", (0, 0), (-1, -1), 4),
                ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                ("TOPPADDING", (0, 0), (-1, -1), 3),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ]
        )
    )
    story.append(table)
    story.append(Spacer(1, 10))

    # Charts (Balken + Linie) als PNG
    chart_data = chart_data if isinstance(chart_data, pd.DataFrame) else pd.DataFrame()
    chart_data = chart_data.dropna(subset=["Preis"]).copy()

    if not chart_data.empty:
        chart_data = chart_data.sort_values(
            ["Datum", "Quelle", "PDF_Order"], ascending=[False, True, True]
        ).reset_index(drop=True)
        prices = chart_data["Preis"].astype(float).tolist()
        positions = list(range(len(prices)))

        if "YMin" in chart_data.columns and not chart_data["YMin"].isna().all():
            y_min = float(chart_data["YMin"].iloc[0])
        else:
            values = [float(value) for value in prices if value is not None]
            y_min = max(0.0, (min(values) if values else 0.0) * 0.5)

        def _basename(value: object) -> str:
            try:
                return Path(str(value)).name.replace("\u00a0", " ").strip()
            except Exception:
                return str(value or "").replace("\u00a0", " ").strip()

        offer_name = _basename(highlight_src) if highlight_src else None
        sources = (
            chart_data["Quelle"].astype(str)
            if "Quelle" in chart_data.columns
            else pd.Series([""] * len(positions))
        ).tolist()

        bar_colors = []
        for source in sources:
            source_name = _basename(source)
            if offer_name and source_name == offer_name:
                bar_colors.append("#ff0000")
            else:
                bar_colors.append("#4682B4")

        # Balken
        fig1 = plt.figure(figsize=(content_width / 3.78 / 10, 2.6), dpi=150)
        ax1 = plt.gca()
        ax1.bar(
            positions,
            prices,
            width=0.8,
            color=bar_colors,
            edgecolor="#444444",
            linewidth=0.5,
        )
        if dn_val is not None:
            ax1.axhline(float(dn_val), linestyle="--", color="red")
        ax1.set_ylim(bottom=y_min)
        ax1.set_xticks([])

        for index, value in enumerate(prices):
            if value is not None:
                ax1.text(index, value, _fmt_eur(value), ha="center", va="bottom", fontsize=8)
        if "DatumLabel" in chart_data.columns:
            for index, label in enumerate(chart_data["DatumLabel"].tolist()):
                ax1.text(index, y_min, str(label), ha="center", va="top", fontsize=7)

        bar_buffer = io.BytesIO()
        fig1.savefig(bar_buffer, format="png", bbox_inches="tight")
        plt.close(fig1)
        bar_buffer.seek(0)
        story.append(Paragraph("Balken-Diagramm", cap))
        story.append(Image(bar_buffer, width=content_width, height=62 * mm))
        story.append(Spacer(1, 8))

        # Linie (Punkte farbig wie Balken)
        fig2 = plt.figure(figsize=(content_width / 3.78 / 10, 2.6), dpi=150)
        ax2 = plt.gca()
        ax2.plot(positions, prices, marker="o", color="#4682B4")
        ax2.scatter(positions, prices, c=bar_colors, s=28, zorder=3)

        if dn_val is not None:
            ax2.axhline(float(dn_val), linestyle="--", color="red")
        ax2.set_ylim(bottom=y_min)
        ax2.set_xticks([])

        for index, value in enumerate(prices):
            if value is not None:
                ax2.text(index, value, _fmt_eur(value), ha="center", va="bottom", fontsize=8)
        if "DatumLabel" in chart_data.columns:
            for index, label in enumerate(chart_data["DatumLabel"].tolist()):
                ax2.text(index, y_min, str(label), ha="center", va="top", fontsize=7)

        line_buffer = io.BytesIO()
        fig2.savefig(line_buffer, format="png", bbox_inches="tight")
        plt.close(fig2)
        line_buffer.seek(0)
        story.append(Paragraph("Linien-Diagramm", cap))
        story.append(Image(line_buffer, width=content_width, height=62 * mm))

    doc.build(story)
    return out.getvalue()


_build_article_pdf_bytes = build_article_pdf_bytes


def build_offer_compilation_pdf(
    offer_src: str,
    df_dn: pd.DataFrame,
    all_prices: pd.DataFrame,
) -> bytes | None:
    """Create the original multi-article PDF for one offer source."""

    if not (REPORTLAB_AVAILABLE and MPL_AVAILABLE):
        return None

    import matplotlib.pyplot as plt
    from reportlab.lib import colors as RL_COLORS
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.platypus import (
        Image,
        PageBreak,
        Paragraph,
        SimpleDocTemplate,
        Spacer,
        Table,
        TableStyle,
    )

    # Filter: alle Positionen dieses Angebots
    if all_prices is None or all_prices.empty:
        return None
    df_offer_all = all_prices[all_prices["Quelle"] == offer_src].copy()
    if df_offer_all.empty:
        return None

    # Kandidaten-Artikel
    articles = df_offer_all["Artikelnummer"].astype(str).map(clean_artnr).dropna().unique().tolist()

    # 12-Monats-Fenster
    now = pd.Timestamp.now(tz=None).normalize()
    since = now - pd.Timedelta(days=365)

    # Seitenbreite
    left = right = 16 * mm
    page_width, _ = A4
    content_width = page_width - left - right

    # Styles
    styles = getSampleStyleSheet()
    h2 = ParagraphStyle(
        "H2",
        parent=styles["BodyText"],
        fontName="Helvetica-Bold",
        fontSize=12,
        leading=15,
        spaceAfter=2,
    )
    cap = ParagraphStyle(
        "CAP",
        parent=styles["BodyText"],
        fontSize=9,
        leading=11,
        textColor=RL_COLORS.grey,
    )

    def _fmt_eur(value: object) -> str:
        try:
            number = float(value)
            return f"{number:,.2f} €".replace(",", "X").replace(".", ",").replace("X", ".")
        except Exception:
            return "—"

    # Datanorm-Helper
    datanorm = df_dn.copy() if df_dn is not None and not df_dn.empty else pd.DataFrame()
    if not datanorm.empty:
        datanorm["Artikelnummer"] = datanorm["Artikelnummer"].astype(str).map(clean_artnr)

    # PDF-Dokument
    out = io.BytesIO()
    doc = SimpleDocTemplate(
        out,
        pagesize=A4,
        leftMargin=left,
        rightMargin=right,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
    )
    story = []

    # Projektname einmalig ganz oben, sourced from the compiled price cache.
    project_name = None
    try:
        if "Projekt" in df_offer_all.columns:
            project_candidates = [
                str(value).replace("\u00a0", " ").strip()
                for value in df_offer_all["Projekt"].dropna().tolist()
                if str(value).strip()
            ]
            project_name = project_candidates[0] if project_candidates else None
    except Exception:
        project_name = None

    header_context = {"title": project_name if project_name else "Projekt", "subtitle": ""}

    def _draw_pdf_header(canvas, current_doc) -> None:
        try:
            y = current_doc.pagesize[1] - 12 * mm
            canvas.saveState()
            canvas.setFont("Helvetica-Bold", 12)
            canvas.drawString(current_doc.leftMargin, y, _safe(header_context.get("title", "")))
            canvas.restoreState()
        except Exception:
            pass

    # Iteriere Artikel des Angebots
    first_section = True
    for article in articles:
        # Historie (alle Angebote) fuer diesen Artikel
        history = all_prices.copy()
        history["Artikelnummer"] = history["Artikelnummer"].astype(str).map(clean_artnr)
        history = history[history["Artikelnummer"] == article].copy()
        if history.empty:
            continue

        # Filter: letzte 12 Monate + Anzahl unterschiedlicher Quellen
        history["Datum"] = pd.to_datetime(history["Datum"], errors="coerce")
        history_recent = history[history["Datum"].ge(since) & history["Datum"].le(now)].copy()
        if history_recent["Quelle"].dropna().astype(str).nunique() < 3:
            continue

        # Anzeige-View (Monat, Preis, Angebot)
        ap_df = history_recent.dropna(subset=["Preis"]).copy()
        if ap_df.empty:
            continue

        ap_df = ap_df.sort_values(["Datum", "Quelle", "PDF_Order"], ascending=[False, True, True])
        ap_df["Monat"] = ap_df["Datum"].dt.strftime("%Y-%m")

        project_column = None
        for column in ap_df.columns:
            if column.lower() in ("projekt", "projektname", "bauvorhaben", "projekt_name"):
                project_column = column
                break

        def _fmt_offer(row: pd.Series) -> str:
            offer = str(row.get("Angebot") or "").strip()
            project = str(row.get(project_column) or "").strip() if project_column else ""
            if project:
                return f"{offer} — {project}"
            return offer or "—"

        ap_view = ap_df.copy()
        ap_view["Angebot_Anzeige"] = ap_view.apply(_fmt_offer, axis=1)
        ap_view = (
            ap_view[["Monat", "Preis", "Angebot_Anzeige"]]
            .rename(columns={"Preis": "Angebotspreis", "Angebot_Anzeige": "Angebot"})
            .copy()
        )
        ap_view["Angebotspreis"] = pd.to_numeric(ap_view["Angebotspreis"], errors="coerce").round(2)

        # Chartdaten (wie in der App)
        chart_data = ap_df[["Datum", "Quelle", "PDF_Order", "Preis"]].copy()
        chart_data = chart_data.sort_values(
            ["Datum", "Quelle", "PDF_Order"], ascending=[False, True, True]
        ).reset_index(drop=True)
        chart_data["DatumLabel"] = chart_data["Datum"].dt.strftime("%m-%y")
        chart_data["PreisLabel"] = chart_data["Preis"].map(
            lambda value: (
                f"{value:,.2f} €".replace(",", "X").replace(".", ",").replace("X", ".")
                if pd.notna(value)
                else ""
            )
        )
        cut_fraction = 0.50
        min_price = (
            float(chart_data["Preis"].min()) if not chart_data["Preis"].isna().all() else 0.0
        )
        y_min = max(0.0, min_price * (1.0 - cut_fraction))
        chart_data["YMin"] = y_min
        chart_data["Pos"] = (chart_data.index + 1).astype(int)

        # Datanorm-Daten
        dn_row = None
        if not datanorm.empty:
            matches = datanorm[datanorm["Artikelnummer"] == article]
            if not matches.empty:
                dn_row = matches.iloc[0]

        bez_lines: list[str] = []
        einheit = ""
        dn_val = None
        if dn_row is not None:
            bez_full = str(dn_row.get("Bezeichnung") or "").strip()
            raw_lines = [line.strip() for line in bez_full.split("\n") if line.strip()]
            skip_prefixes = ("Mat.:", "Einheit:")
            skip_exact = {"für Kabelleiter"}
            bez_lines = [
                line
                for line in raw_lines
                if not any(line.startswith(prefix) for prefix in skip_prefixes)
                and line not in skip_exact
            ]
            if len(bez_lines) >= 3:
                bez_lines.pop(2)
            einheit = str(dn_row.get("Einheit") or "").strip()
            try:
                dn_val = (
                    float(dn_row.get("Nettopreis")) if pd.notna(dn_row.get("Nettopreis")) else None
                )
            except Exception:
                dn_val = None

        # Untertitel fuer den Seitenkopf dieser Artikelseite setzen
        bez1 = str(bez_lines[0]).strip() if len(bez_lines) >= 1 else ""
        badge2 = str(bez_lines[1]).strip() if len(bez_lines) >= 2 else bez1
        unit = str(einheit).strip() if str(einheit or "").strip() else ""
        left_text = " — ".join([part for part in [badge2, bez1] if part])
        right_text = " • ".join([part for part in [unit, str(article)] if part])
        header_context["subtitle"] = left_text + ((" • " + right_text) if right_text else "")

        # Abschnitt layouten
        if not first_section:
            story.append(PageBreak())
        first_section = False

        story.append(Spacer(1, 6))
        story.append(Paragraph(str(header_context.get("subtitle", "")), h2))
        story.append(Spacer(1, 6))

        # Mini-Tabelle Datanorm
        dn_table = Table(
            [["Datanorm-Preis", _fmt_eur(dn_val) if dn_val is not None else "—"]],
            colWidths=[content_width * 0.30, content_width * 0.70],
        )
        dn_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), RL_COLORS.HexColor("#f0f2f7")),
                    ("BOX", (0, 0), (-1, -1), 0.5, RL_COLORS.HexColor("#cfd3dc")),
                    (
                        "INNERGRID",
                        (0, 0),
                        (-1, -1),
                        0.25,
                        RL_COLORS.HexColor("#cfd3dc"),
                    ),
                    ("FONTNAME", (0, 0), (0, 0), "Helvetica-Bold"),
                    ("ALIGN", (1, 0), (1, 0), "RIGHT"),
                    ("FONTSIZE", (0, 0), (-1, -1), 10),
                    ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]
            )
        )
        story.append(dn_table)
        story.append(Spacer(1, 8))

        # Angebote-Tabelle (Monat | Angebotspreis | Angebot) - volle Breite
        columns = ["Monat", "Angebotspreis", "Angebot"]
        column_widths = [
            content_width * 0.12,
            content_width * 0.14,
            content_width * 0.74,
        ]
        max_text_width = max(10, column_widths[2] - 8)

        def _truncate_to_width(text: str, font_name: str = "Helvetica", font_size: int = 9) -> str:
            value = "—" if text is None else str(text).replace("\u00a0", " ").strip()
            if not value:
                return "—"
            if pdfmetrics.stringWidth(value, font_name, font_size) <= max_text_width:
                return value

            ellipsis = "…"
            low, high = 0, len(value)
            best = ellipsis
            while low <= high:
                middle = (low + high) // 2
                candidate = value[:middle].rstrip() + ellipsis
                if pdfmetrics.stringWidth(candidate, font_name, font_size) <= max_text_width:
                    best = candidate
                    low = middle + 1
                else:
                    high = middle - 1
            return best

        table_data = [columns] + [
            [
                row["Monat"],
                _fmt_eur(row["Angebotspreis"]),
                _truncate_to_width(row["Angebot"] if pd.notna(row["Angebot"]) else "—"),
            ]
            for _, row in ap_view.iterrows()
        ]

        table = Table(table_data, colWidths=column_widths, repeatRows=1)
        table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), RL_COLORS.HexColor("#444444")),
                    ("TEXTCOLOR", (0, 0), (-1, 0), RL_COLORS.white),
                    ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                    ("ALIGN", (1, 1), (1, -1), "RIGHT"),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    (
                        "ROWBACKGROUNDS",
                        (0, 1),
                        (-1, -1),
                        [RL_COLORS.whitesmoke, RL_COLORS.HexColor("#f5f7fb")],
                    ),
                    ("GRID", (0, 0), (-1, -1), 0.25, RL_COLORS.HexColor("#cfd3dc")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 4),
                    ("TOPPADDING", (0, 0), (-1, -1), 3),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
                ]
            )
        )
        story.append(table)
        story.append(Spacer(1, 10))

        # Original compilation currently inserts only the bar chart into the PDF.
        try:
            prices = chart_data["Preis"].astype(float).tolist()
            positions = list(range(len(prices)))

            def _basename(value: object) -> str:
                try:
                    return Path(str(value)).name.replace("\u00a0", " ").strip()
                except Exception:
                    return str(value or "").replace("\u00a0", " ").strip()

            offer_name = _basename(offer_src)
            sources = (
                chart_data["Quelle"].astype(str)
                if "Quelle" in chart_data.columns
                else pd.Series([""] * len(positions))
            ).tolist()
            bar_colors = [
                "#ff0000" if _basename(source) == offer_name else "#4682B4" for source in sources
            ]

            figure = plt.figure(figsize=(content_width / 3.78 / 10, 2.6), dpi=150)
            axis = plt.gca()
            axis.bar(positions, prices, color=bar_colors)
            if dn_val is not None:
                axis.axhline(float(dn_val), linestyle="--", color="red")
            axis.set_title(f"Angebotspreise – Balken (Art. {article})")
            axis.set_ylabel("€")
            axis.set_ylim(bottom=y_min)
            axis.ticklabel_format(axis="y", style="plain")
            axis.yaxis.get_major_formatter().set_useOffset(False)
            axis.set_xticks([])

            for index, value in enumerate(prices):
                if value is not None:
                    label = f"{value:,.2f} €".replace(",", "X").replace(".", ",").replace("X", ".")
                    axis.text(
                        index,
                        value,
                        label,
                        ha="center",
                        va="bottom",
                        fontsize=8,
                    )
            if "DatumLabel" in chart_data.columns:
                for index, label in enumerate(chart_data["DatumLabel"].tolist()):
                    axis.text(index, y_min, str(label), ha="center", va="top", fontsize=7)

            bar_buffer = io.BytesIO()
            figure.savefig(bar_buffer, format="png", bbox_inches="tight")
            plt.close(figure)
            bar_buffer.seek(0)

            story.append(Paragraph("Balken-Diagramm", cap))
            story.append(Image(bar_buffer, width=content_width, height=62 * mm))
            story.append(Spacer(1, 8))
        except Exception:
            pass

    if not story:
        return None

    doc.build(story, onFirstPage=_draw_pdf_header, onLaterPages=_draw_pdf_header)
    return out.getvalue()


_build_offer_compilation_pdf = build_offer_compilation_pdf


__all__ = [
    "MPL_AVAILABLE",
    "REPORTLAB_AVAILABLE",
    "SOURCE_PROVENANCE",
    "build_article_pdf_bytes",
    "build_offer_compilation_pdf",
]
