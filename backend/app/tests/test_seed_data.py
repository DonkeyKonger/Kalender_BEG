from app.seed_data import absence_seed_signature_matches


def test_absence_seed_signature_matches_deleted_seed_absence():
    signature = {
        "person_id": 7,
        "absence_type": "vacation",
        "start_date": "2026-06-08",
        "end_date": "2026-06-12",
        "note": "Seed: Urlaub blockiert Einplanung hart.",
    }

    assert absence_seed_signature_matches(dict(signature), signature)


def test_absence_seed_signature_rejects_different_seed_absence():
    signature = {
        "person_id": 7,
        "absence_type": "vacation",
        "start_date": "2026-06-08",
        "end_date": "2026-06-12",
        "note": "Seed: Urlaub blockiert Einplanung hart.",
    }
    old_value = {
        **signature,
        "end_date": "2026-06-11",
    }

    assert not absence_seed_signature_matches(old_value, signature)
