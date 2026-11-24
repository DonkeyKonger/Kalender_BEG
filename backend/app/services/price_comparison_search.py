"""Immutable search rows preserving the price viewer's literal all-column search."""
from dataclasses import dataclass
from functools import lru_cache
import json

import pandas as pd


@dataclass(frozen=True)
class ArticleSearchRow:
    article_number: str
    description: str
    net_price: float | None
    search_values: tuple[str, ...]

    def summary(self):
        return {"article_number": self.article_number, "description": self.description,
                "net_price": self.net_price}

    def browser_row(self):
        return (self.article_number, self.description, self.net_price, self.search_values)


def build_article_search_index(frame: pd.DataFrame) -> tuple[ArticleSearchRow, ...]:
    if frame.empty:
        return ()
    columns = [name for name in ("Artikelnummer", "Bezeichnung", "Nettopreis") if name in frame]
    summaries = json.loads(frame[columns].to_json(orient="records", date_format="iso", double_precision=15))
    # Keep individual cells: joining columns could introduce matches that never
    # existed in a cell, changing the original filter_frame() semantics.
    searchable = frame.astype(str).itertuples(index=False, name=None)
    return tuple(
        ArticleSearchRow(str(row["Artikelnummer"]), str(row.get("Bezeichnung", "")),
                         row.get("Nettopreis"), tuple(cell.casefold() for cell in cells))
        for row, cells in zip(summaries, searchable, strict=True)
    )


def search_article_index(index: tuple[ArticleSearchRow, ...], search: str, limit: int):
    needle = search.strip().casefold()
    if not needle:
        return [row.summary() for row in index[:limit]]
    matches = []
    for row in index:
        if any(needle in value for value in row.search_values):
            matches.append(row.summary())
            if len(matches) >= limit:
                break
    return matches


@lru_cache(maxsize=1)
def unicode_casefold_items() -> tuple[tuple[str, str], ...]:
    # Supply the server's Unicode rules, including ß, ligatures and Greek final
    # sigma. JavaScript lowercasing alone is not equivalent to Python casefold.
    return tuple((char, char.casefold()) for code in range(0x110000)
                 if (char := chr(code)).casefold() != char)
