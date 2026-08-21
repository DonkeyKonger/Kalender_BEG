import pytest

from app.scripts import azure_deploy_guard
from app.scripts.azure_deploy_guard import (
    HttpResult,
    parse_publish_profile,
    release_matches,
    select_previous_deployment,
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


def test_select_previous_deployment_prefers_active_success() -> None:
    deployments = [
        {"id": "failed", "status": 3, "active": False},
        {"id": "older", "status": 4, "active": False},
        {"id": "current", "status": 4, "active": True},
    ]

    assert select_previous_deployment(deployments) == deployments[2]


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


def test_tool_import_failure_fails_the_deployment(monkeypatch) -> None:
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

    with pytest.raises(RuntimeError, match="Tool import verification failed"):
        azure_deploy_guard.verify_release(
            target,
            expected_revision="a" * 40,
            expected_tool_source_sha256="tool-sha",
            delay_seconds=0,
        )


def test_rollback_redeploys_captured_kudu_release(monkeypatch) -> None:
    target = parse_publish_profile(PUBLISH_PROFILE)
    calls: list[tuple[str, str, object]] = []

    def fake_request(url, *, method="GET", payload=None, **_kwargs):
        calls.append((url, method, payload))
        return HttpResult(200, b"{}")

    monkeypatch.setattr(azure_deploy_guard, "_request", fake_request)
    monkeypatch.setattr(
        azure_deploy_guard,
        "_wait_for_release",
        lambda *_args, **_kwargs: {"status": "ok", "revision": "b" * 40},
    )

    azure_deploy_guard.rollback_release(
        target,
        deployment_id="known-good/id",
        expected_revision="b" * 40,
        delay_seconds=0,
    )

    assert calls == [
        (
            "https://example.scm.azurewebsites.net:443/api/deployments/known-good%2Fid",
            "PUT",
            {"clean": True, "needFileUpdate": True},
        )
    ]
