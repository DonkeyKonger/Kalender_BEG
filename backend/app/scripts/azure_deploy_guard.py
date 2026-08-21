"""Deploy, verify, and restore versioned Azure release packages."""

from __future__ import annotations

import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


@dataclass(frozen=True)
class AzurePublishTarget:
    username: str
    password: str
    scm_base_url: str
    app_base_url: str


@dataclass(frozen=True)
class HttpResult:
    status: int
    body: bytes

    def json(self) -> object:
        return json.loads(self.body.decode("utf-8"))


def parse_publish_profile(xml_content: str) -> AzurePublishTarget:
    root = ET.fromstring(xml_content)
    profiles = root.findall("publishProfile")
    profile = next(
        (item for item in profiles if item.attrib.get("publishMethod") == "ZipDeploy"),
        None,
    )
    if profile is None:
        profile = next(
            (item for item in profiles if item.attrib.get("publishMethod") == "MSDeploy"),
            None,
        )
    if profile is None:
        raise ValueError("Publish profile does not contain ZipDeploy/MSDeploy credentials.")

    publish_url = profile.attrib["publishUrl"].strip()
    if not publish_url.startswith(("http://", "https://")):
        publish_url = f"https://{publish_url}"
    parsed_publish_url = urlsplit(publish_url)
    scm_base_url = urlunsplit(
        (parsed_publish_url.scheme, parsed_publish_url.netloc, "", "", "")
    ).rstrip("/")
    app_base_url = profile.attrib.get("destinationAppUrl", "").rstrip("/")
    if not app_base_url:
        raise ValueError("Publish profile does not contain destinationAppUrl.")
    return AzurePublishTarget(
        username=profile.attrib["userName"],
        password=profile.attrib["userPWD"],
        scm_base_url=scm_base_url,
        app_base_url=app_base_url,
    )


def release_matches(health: object, expected_revision: str | None) -> bool:
    if not isinstance(health, dict) or health.get("status") != "ok":
        return False
    return not expected_revision or health.get("revision") == expected_revision


def _request(
    url: str,
    *,
    method: str = "GET",
    auth: tuple[str, str] | None = None,
    payload: object | None = None,
    timeout: float = 20,
) -> HttpResult:
    headers = {"Accept": "application/json"}
    data = None
    if auth:
        token = base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return HttpResult(response.status, response.read())
    except urllib.error.HTTPError as error:
        return HttpResult(error.code, error.read())


def _health(target: AzurePublishTarget) -> HttpResult:
    return _request(f"{target.app_base_url}/api/health")


def _login_probe(target: AzurePublishTarget) -> HttpResult:
    return _request(
        f"{target.app_base_url}/api/auth/login",
        method="POST",
        payload={"username": "__deployment_probe__", "password": "__invalid__"},
    )


def deploy_package(target: AzurePublishTarget, package_path: Path) -> None:
    package = package_path.resolve()
    if not package.is_file():
        raise RuntimeError(f"Deployment package does not exist: {package}")
    token = base64.b64encode(f"{target.username}:{target.password}".encode()).decode()
    request = urllib.request.Request(
        f"{target.scm_base_url}/api/zipdeploy",
        data=package.read_bytes(),
        headers={
            "Authorization": f"Basic {token}",
            "Content-Type": "application/zip",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=600) as response:
            status = response.status
            body = response.read()
    except urllib.error.HTTPError as error:
        status = error.code
        body = error.read()
    if status not in {200, 201, 202}:
        detail = body.decode(errors="replace")[-1000:]
        raise RuntimeError(f"Azure ZipDeploy returned HTTP {status}: {detail}")
    print(f"Azure accepted deployment package {package.name} with HTTP {status}.")


def _wait_for_release(
    target: AzurePublishTarget,
    *,
    expected_revision: str | None,
    attempts: int,
    delay_seconds: float,
) -> dict[str, object]:
    last_detail = "no response"
    for attempt in range(1, attempts + 1):
        health_result = _health(target)
        try:
            health = health_result.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            health = None
        login_result = _login_probe(target) if health_result.status == 200 else None
        if (
            health_result.status == 200
            and release_matches(health, expected_revision)
            and login_result is not None
            and login_result.status == 401
        ):
            assert isinstance(health, dict)
            return health
        last_detail = (
            f"health HTTP {health_result.status}: {str(health)[:500]}; "
            f"login HTTP {login_result.status if login_result else 'not checked'}"
        )
        if attempt < attempts:
            time.sleep(delay_seconds)
    raise RuntimeError(f"Release verification failed: {last_detail}")


def verify_release(
    target: AzurePublishTarget,
    *,
    expected_revision: str,
    expected_tool_source_sha256: str,
    delay_seconds: float = 5,
) -> None:
    health = _wait_for_release(
        target,
        expected_revision=expected_revision,
        attempts=90,
        delay_seconds=delay_seconds,
    )
    print("Exact release and login probe ready: " + json.dumps(health, sort_keys=True))

    tool_url = f"{target.app_base_url}/api/health/tool-import"
    last_tool_detail = "no response"
    for attempt in range(1, 13):
        _wait_for_release(
            target,
            expected_revision=expected_revision,
            attempts=1,
            delay_seconds=delay_seconds,
        )
        tool_result = _request(tool_url)
        try:
            tool_health = tool_result.json()
        except (json.JSONDecodeError, UnicodeDecodeError):
            tool_health = None
        if (
            tool_result.status == 200
            and isinstance(tool_health, dict)
            and tool_health.get("status") == "ok"
            and tool_health.get("source_sha256") == expected_tool_source_sha256
            and tool_health.get("imported_rows") == tool_health.get("expected_rows")
        ):
            print("Tool import ready: " + json.dumps(tool_health, sort_keys=True))
            break
        last_tool_detail = f"HTTP {tool_result.status}: {str(tool_health)[:500]}"
        if attempt < 12:
            time.sleep(delay_seconds)
    else:
        print(f"::warning::Tool import is not ready yet: {last_tool_detail}")

    for _ in range(6):
        time.sleep(delay_seconds)
        _wait_for_release(
            target,
            expected_revision=expected_revision,
            attempts=1,
            delay_seconds=delay_seconds,
        )
    print("Release remained healthy throughout the stability window.")


def restore_release(
    target: AzurePublishTarget,
    *,
    package_path: Path,
    expected_revision: str | None,
    delay_seconds: float = 5,
) -> None:
    deploy_package(target, package_path)
    revision = expected_revision if expected_revision not in {"", "development"} else None
    health = _wait_for_release(
        target,
        expected_revision=revision,
        attempts=90,
        delay_seconds=delay_seconds,
    )
    print("Previous release restored: " + json.dumps(health, sort_keys=True))


def _target_from_environment() -> AzurePublishTarget:
    profile = os.environ.get("PUBLISH_PROFILE")
    if not profile:
        raise SystemExit("PUBLISH_PROFILE is required.")
    target = parse_publish_profile(profile)
    print(f"::add-mask::{target.username}")
    print(f"::add-mask::{target.password}")
    return target


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    deploy_parser = subparsers.add_parser("deploy")
    deploy_parser.add_argument("--package", type=Path, required=True)
    verify_parser = subparsers.add_parser("verify")
    verify_parser.add_argument("--expected-revision", required=True)
    verify_parser.add_argument("--expected-tool-source-sha256", required=True)
    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("--package", type=Path, required=True)
    restore_parser.add_argument("--expected-revision", default="")
    args = parser.parse_args()

    target = _target_from_environment()
    if args.command == "deploy":
        deploy_package(target, args.package)
    elif args.command == "verify":
        verify_release(
            target,
            expected_revision=args.expected_revision,
            expected_tool_source_sha256=args.expected_tool_source_sha256,
        )
    else:
        restore_release(
            target,
            package_path=args.package,
            expected_revision=args.expected_revision,
        )


if __name__ == "__main__":
    main()
