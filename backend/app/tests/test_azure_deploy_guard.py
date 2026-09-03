from pathlib import Path

import pytest

from app.scripts import azure_deploy_guard
from app.scripts.azure_deploy_guard import (
    HttpResult,
    parse_publish_profile,
    release_matches,
)


PUBLISH_PROFILE = """\
<publishData>
  <publishProfile
    publishMethod="ZipDeploy"
    publishUrl="example.scm.azurewebsites.net:443/api/zipdeploy"
    userName="deploy-user"
    userPWD="deploy-password"
    destinationAppUrl="https://example.azurewebsites.net"
  />
</publishData>
"""


def test_parse_publish_profile_derives_scm_and_app_urls() -> None:
    target = parse_publish_profile(PUBLISH_PROFILE)

    assert target.username == "deploy-user"
    assert target.password == "deploy-password"
    assert target.scm_base_url == "https://example.scm.azurewebsites.net:443"
    assert target.app_base_url == "https://example.azurewebsites.net"


def test_release_match_requires_exact_revision() -> None:
    health = {"status": "ok", "revision": "a" * 40}

    assert release_matches(health, "a" * 40)
    assert not release_matches(health, "b" * 40)
    assert not release_matches({"status": "pending", "revision": "a" * 40}, "a" * 40)


def test_wait_for_release_ignores_old_healthy_revision(monkeypatch) -> None:
    target = parse_publish_profile(PUBLISH_PROFILE)
    health_results = iter(
        [
            HttpResult(200, b'{"status":"ok","revision":"oldold1"}'),
            HttpResult(200, b'{"status":"ok","revision":"newnew2"}'),
        ]
    )
    monkeypatch.setattr(azure_deploy_guard, "_health", lambda _target: next(health_results))
    monkeypatch.setattr(
        azure_deploy_guard,
        "_login_probe",
        lambda _target: HttpResult(401, b'{"detail":"invalid"}'),
    )
    monkeypatch.setattr(azure_deploy_guard.time, "sleep", lambda _seconds: None)

    health = azure_deploy_guard._wait_for_release(
        target,
        expected_revision="newnew2",
        attempts=2,
        delay_seconds=0,
    )

    assert health["revision"] == "newnew2"


def test_tool_import_pending_warns_while_core_release_stays_healthy(
    monkeypatch,
    capsys,
) -> None:
    target = parse_publish_profile(PUBLISH_PROFILE)
    monkeypatch.setattr(
        azure_deploy_guard,
        "_wait_for_release",
        lambda *_args, **_kwargs: {"status": "ok", "revision": "a" * 40},
    )
    monkeypatch.setattr(
        azure_deploy_guard,
        "_request",
        lambda *_args, **_kwargs: HttpResult(503, b'{"status":"pending"}'),
    )
    monkeypatch.setattr(azure_deploy_guard.time, "sleep", lambda _seconds: None)

    azure_deploy_guard.verify_release(
        target,
        expected_revision="a" * 40,
        expected_tool_source_sha256="tool-sha",
        delay_seconds=0,
    )

    assert "::warning::Tool import is not ready yet" in capsys.readouterr().out


@pytest.fixture
def release_probes(monkeypatch):
    calls = {"health": 0, "tool": 0, "sleep": []}
    healthy = HttpResult(200, b'{"status":"ok","revision":"newnew2"}')

    def health(_target):
        calls["health"] += 1
        return healthy

    def tool_request(url):
        assert url.endswith("/api/health/tool-import")
        calls["tool"] += 1
        return HttpResult(
            200,
            b'{"status":"ok","source_sha256":"tool-sha",'
            b'"imported_rows":10,"expected_rows":10}',
        )

    monkeypatch.setattr(azure_deploy_guard, "_health", health)
    monkeypatch.setattr(
        azure_deploy_guard, "_login_probe", lambda _target: HttpResult(401, b"{}")
    )
    monkeypatch.setattr(azure_deploy_guard, "_request", tool_request)
    monkeypatch.setattr(azure_deploy_guard.time, "sleep", calls["sleep"].append)
    return calls, healthy


@pytest.mark.parametrize("failed_check", [2, 3, 8])
def test_verify_retries_502_before_tool_import_and_during_stability(
    monkeypatch, capsys, release_probes, failed_check
) -> None:
    calls, healthy = release_probes

    def health(_target):
        calls["health"] += 1
        if calls["health"] == failed_check:
            return HttpResult(502, b"Bad Gateway")
        return healthy

    monkeypatch.setattr(azure_deploy_guard, "_health", health)

    azure_deploy_guard.verify_release(
        parse_publish_profile(PUBLISH_PROFILE),
        expected_revision="newnew2",
        expected_tool_source_sha256="tool-sha",
    )

    assert calls["health"] == 9  # Initial + tool readiness + six stability checks + retry.
    assert calls["tool"] == 1
    assert calls["sleep"] == [5] * 7
    output = capsys.readouterr().out
    assert "health HTTP 502" in output
    assert "retrying in 5s" in output
    assert "Release passed all health checks" in output


@pytest.mark.parametrize("failed_check", [2, 3])
@pytest.mark.parametrize("failure", ["502", "wrong_revision", "bad_login", "invalid_json"])
def test_verify_fails_after_bounded_retries_without_accepting_unhealthy_release(
    monkeypatch, capsys, release_probes, failed_check, failure
) -> None:
    calls, healthy = release_probes

    def health(_target):
        calls["health"] += 1
        if calls["health"] >= failed_check:
            if failure == "502":
                return HttpResult(502, b"Bad Gateway")
            if failure == "wrong_revision":
                return HttpResult(200, b'{"status":"ok","revision":"oldold1"}')
            if failure == "invalid_json":
                return HttpResult(200, b"not JSON")
        return healthy

    def login(_target):
        status = 500 if failure == "bad_login" and calls["health"] >= failed_check else 401
        return HttpResult(status, b"{}")

    monkeypatch.setattr(azure_deploy_guard, "_health", health)
    monkeypatch.setattr(azure_deploy_guard, "_login_probe", login)

    with pytest.raises(RuntimeError, match="Release verification failed"):
        azure_deploy_guard.verify_release(
            parse_publish_profile(PUBLISH_PROFILE),
            expected_revision="newnew2",
            expected_tool_source_sha256="tool-sha",
        )

    assert calls["health"] == failed_check - 1 + 6
    assert calls["tool"] == failed_check - 2
    assert calls["sleep"] == [5] * (5 + failed_check - 2)
    output = capsys.readouterr().out
    assert "Release passed all health checks" not in output
    assert "retrying in 5s" in output


def test_restore_deploys_previous_package_and_waits_for_its_revision(
    monkeypatch,
    tmp_path: Path,
) -> None:
    target = parse_publish_profile(PUBLISH_PROFILE)
    package = tmp_path / "previous.zip"
    package.write_bytes(b"previous")
    deployed: list[Path] = []
    expected_revisions: list[str | None] = []
    monkeypatch.setattr(
        azure_deploy_guard,
        "deploy_package",
        lambda _target, package_path: deployed.append(package_path),
    )

    def fake_wait(_target, *, expected_revision, **_kwargs):
        expected_revisions.append(expected_revision)
        return {"status": "ok", "revision": expected_revision}

    monkeypatch.setattr(azure_deploy_guard, "_wait_for_release", fake_wait)

    azure_deploy_guard.restore_release(
        target,
        package_path=package,
        expected_revision="b" * 40,
        delay_seconds=0,
    )

    assert deployed == [package]
    assert expected_revisions == ["b" * 40]


def test_deploy_rejects_missing_package(tmp_path: Path) -> None:
    target = parse_publish_profile(PUBLISH_PROFILE)

    with pytest.raises(RuntimeError, match="does not exist"):
        azure_deploy_guard.deploy_package(target, tmp_path / "missing.zip")


def test_deploy_uploads_versioned_zip_to_kudu(monkeypatch, tmp_path: Path) -> None:
    target = parse_publish_profile(PUBLISH_PROFILE)
    package = tmp_path / "release.zip"
    package.write_bytes(b"versioned-release")
    captured = {}

    class FakeResponse:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b""

    def fake_urlopen(request, *, timeout):
        captured["request"] = request
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr(azure_deploy_guard.urllib.request, "urlopen", fake_urlopen)

    azure_deploy_guard.deploy_package(target, package)

    request = captured["request"]
    assert request.full_url == "https://example.scm.azurewebsites.net:443/api/zipdeploy"
    assert request.method == "POST"
    assert request.data == b"versioned-release"
    assert request.get_header("Content-type") == "application/zip"
    assert captured["timeout"] == 600
