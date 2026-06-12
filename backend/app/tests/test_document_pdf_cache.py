from app.services.document_pdf_cache import DocumentPdfCache, build_pdf_version_hash


def test_document_pdf_cache_reuses_same_version(tmp_path):
    cache = DocumentPdfCache(cache_dir=str(tmp_path))
    calls = {"count": 0}

    def build() -> bytes:
        calls["count"] += 1
        return b"%PDF-version-1"

    first_content, first_hit = cache.get_or_build(
        cache_key="extra-work-1",
        version_hash=build_pdf_version_hash({"version": 1}),
        build=build,
    )
    second_content, second_hit = cache.get_or_build(
        cache_key="extra-work-1",
        version_hash=build_pdf_version_hash({"version": 1}),
        build=build,
    )

    assert first_content == b"%PDF-version-1"
    assert second_content == b"%PDF-version-1"
    assert first_hit is False
    assert second_hit is True
    assert calls["count"] == 1


def test_document_pdf_cache_invalidates_changed_version(tmp_path):
    cache = DocumentPdfCache(cache_dir=str(tmp_path))

    first_content, first_hit = cache.get_or_build(
        cache_key="measurement-1-checked",
        version_hash=build_pdf_version_hash({"photos": [1]}),
        build=lambda: b"%PDF-version-1",
    )
    second_content, second_hit = cache.get_or_build(
        cache_key="measurement-1-checked",
        version_hash=build_pdf_version_hash({"photos": [1, 2]}),
        build=lambda: b"%PDF-version-2",
    )

    assert first_content == b"%PDF-version-1"
    assert second_content == b"%PDF-version-2"
    assert first_hit is False
    assert second_hit is False
    assert len(list(tmp_path.glob("measurement-1-checked-*.pdf"))) == 1
