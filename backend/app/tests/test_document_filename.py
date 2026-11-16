from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.services.document_filename import (
    extra_work_filename,
    measurement_filename,
    measurement_group_filename,
)


def document(**overrides):
    submitted = datetime(2026, 11, 3, 10, tzinfo=timezone.utc)
    values = dict(
        id=3, site_id=8031,
        site=SimpleNamespace(site_number="8031", name="CHC Emden"),
        number=3, sequence_number=3, display_number="8031.Z03",
        origin="MONTEUR", status="submitted", submitted_by_user_id=7,
        submitted_at=submitted, first_submitted_at=submitted,
        first_worker_submitted_at=submitted,
        first_reviewed_or_completed_at=None, original_submitted_snapshot=None,
        status_history=[], invoiced_at=None,
    )
    values.update(overrides)
    if "first_submitted_at" in overrides and "first_worker_submitted_at" not in overrides:
        values["first_worker_submitted_at"] = overrides["first_submitted_at"]
    return SimpleNamespace(**values)


def test_requested_names_share_one_schema():
    assert measurement_filename(document()) == "8031.03_261103_CHC_Emden.pdf"
    assert extra_work_filename(document()) == "8031.Z03_261103_CHC_Emden.pdf"


def test_review_does_not_replace_worker_submission_day():
    batch = document()
    batch.status = "reviewed"
    batch.first_reviewed_or_completed_at = datetime(2026, 11, 16, tzinfo=timezone.utc)
    assert measurement_filename(batch) == "8031.03_261103_CHC_Emden.pdf"


def test_legacy_extra_work_number_keeps_issued_sequence_with_canonical_z_prefix():
    ticket = document(display_number="8031.SZ15", sequence_number=3)
    assert extra_work_filename(ticket) == "8031.Z15_261103_CHC_Emden.pdf"
    assert ticket.display_number == "8031.SZ15"


def test_unrelated_display_number_cannot_change_extra_work_running_number():
    assert extra_work_filename(document(display_number="OTHER.Z20")) == "8031.Z03_261103_CHC_Emden.pdf"


def test_sequences_do_not_collide_on_same_site_and_day():
    assert measurement_filename(document(number=3)) != measurement_filename(document(number=4))
    assert extra_work_filename(document()) != measurement_filename(document())


@pytest.mark.parametrize("builder", [measurement_filename, extra_work_filename])
def test_names_use_business_day_and_clean_site_name(builder):
    late = datetime(2026, 11, 2, 23, 30, tzinfo=timezone.utc)
    row = document(first_submitted_at=late, submitted_at=late,
        site=SimpleNamespace(site_number="8031", name=' CHC / Emden: Süd\\Neubau? '))
    name = builder(row)
    assert name.endswith("_261103_CHC_Emden_Süd_Neubau.pdf")
    assert not any(char in name for char in '/\\:*?"<>|')


@pytest.mark.parametrize("builder", [measurement_filename, extra_work_filename])
def test_draft_and_unverifiable_historical_date_are_explicit(builder):
    row = document(status="draft", submitted_at=None, first_submitted_at=None,
                   submitted_by_user_id=None)
    assert "_Entwurf_" in builder(row)
    row.status = "completed"
    assert "_ohne_Datum_" in builder(row)


@pytest.mark.parametrize("builder", [measurement_filename, extra_work_filename])
def test_unicode_filename_stays_within_filesystem_limit(builder):
    row = document(site=SimpleNamespace(site_number="8031", name="Ä" * 200))
    name = builder(row)
    assert len(name.encode("utf-8")) <= 224
    assert name.endswith(".pdf")


def test_group_keeps_g_marker_and_uses_leading_source_submission():
    older = document(id=2, number=2, first_submitted_at=datetime(2026, 10, 20, tzinfo=timezone.utc))
    leading = document()
    group = SimpleNamespace(number_label="8031.03G")
    assert measurement_group_filename(group, {2: older, 3: leading}) == "8031.03G_261103_CHC_Emden.pdf"


def test_missing_commission_number_uses_site_id_to_avoid_cross_site_collisions():
    row = document(site=SimpleNamespace(site_number=None, name="Baustelle"))
    assert measurement_filename(row).startswith("Baustelle_8031.03_")
