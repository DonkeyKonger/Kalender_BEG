"""Integration QA against the explicitly isolated local stack only.

No cloud credentials are read; login uses the newly generated local-only account.
--restore additionally round-trips the initial empty test DB into a new local DB.
"""

import argparse
import json
from pathlib import Path
import subprocess
from datetime import datetime
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import manage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore", action="store_true")
    args = parser.parse_args()
    config = manage.initialize()
    manage.ensure_engine()
    assert manage.local_health(), "Not the isolated local test server"
    opener = build_opener(ProxyHandler({}))
    with opener.open(manage.URL + "/__local-test__/") as response:
        assert response.headers["X-BEG-Environment"] == "isolated-local-test"
        assert "connect-src 'self'" in response.headers["Content-Security-Policy"]
        assert "TESTKALENDER" in response.read().decode()
    payload = json.dumps({"username": "local-test-admin", "password": config["LOCAL_ADMIN_PASSWORD"]}).encode()
    with opener.open(Request(manage.URL + "/api/auth/login", data=payload, headers={"Content-Type": "application/json"})) as response:
        token = json.load(response)["access_token"]
    with opener.open(Request(manage.URL + "/api/auth/me", headers={"Authorization": f"Bearer {token}"})) as response:
        user = json.load(response)
        assert user["username"] == "local-test-admin" and user["role"] == "admin"
    try:
        opener.open(manage.URL + "/api/does-not-exist")
        raise AssertionError("Unknown API route returned an HTML success")
    except HTTPError as error:
        assert error.code == 404
    print("PASS: local HTTP, CSP, normal password login, admin identity and API 404")

    configuration = json.loads(manage.compose("config", "--format", "json", capture_output=True, text=True).stdout)
    for name in ["app", "db"]:
        assert set(configuration["services"][name]["networks"]) == {"isolated"}
        assert not configuration["services"][name].get("ports")
    assert configuration["networks"]["isolated"]["internal"] is True
    port = configuration["services"]["gateway"]["ports"][0]
    assert port["host_ip"] == "127.0.0.1" and port["published"] == "18727"
    manage.compose("exec", "-T", "app", "python", "-c", (
        "import socket; "
        "db=socket.create_connection(('db',5432),timeout=3); db.close(); "
        "s=socket.socket(); s.settimeout(3); result=s.connect_ex(('1.1.1.1',443)); s.close(); "
        "assert result != 0, 'Unexpected internet egress'; "
        "print('PASS: local database reachable; direct internet connection blocked')"
    ))
    print("PASS: no backend/database published ports, isolated network, loopback-only gateway")

    if args.restore:
        metadata = json.loads((manage.STATE / "metadata.json").read_text())
        assert metadata["data_label"].startswith("Leere Testdatenbank"), "Restore smoke test is for the initial empty database only"
        backup = manage.STATE / "initial-self-test.dump"
        with backup.open("wb") as stream:
            backup.chmod(0o600)
            manage.compose("exec", "-T", "db", "pg_dump", "-U", "kalender_test", "-Fc", config["LOCAL_DB_NAME"], stdout=stream)
        result = subprocess.run([
            manage.sys.executable, str(Path(manage.__file__)), "import", str(backup),
            "--snapshot-date", datetime.now().strftime("%Y-%m-%d"), "--replace-local-data",
        ], check=True)
        assert result.returncode == 0 and manage.local_health()
        # This was not a cloud import: restore the truthful empty-data label.
        manage.save_metadata(metadata)
        print("PASS: real PostgreSQL dump/restore, migrations and switch; original local DB retained")


if __name__ == "__main__":
    main()
