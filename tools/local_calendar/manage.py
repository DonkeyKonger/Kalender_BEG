#!/usr/bin/env python3
"""Manage only this project's isolated local test calendar, never the cloud.

No project .env is read. Docker context/project, database role, port and network
are fixed. Imports create a NEW local database and retain the previous one.
"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
from datetime import datetime
from urllib.error import URLError
from urllib.request import ProxyHandler, build_opener

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".local-calendar"
HERE = Path(__file__).resolve().parent
URL = "http://127.0.0.1:18727"
CONTEXT = "desktop-linux"
PROJECT = "beg-local-test"
DATABASE_RE = re.compile(r"kalender_test(?:_[0-9a-f]+)?\Z")
ENV_KEYS = {"LOCAL_DB_PASSWORD", "LOCAL_DB_NAME", "LOCAL_SECRET_KEY", "LOCAL_ADMIN_PASSWORD"}


def clean_env():
    # Docker's local credential helper needs HOME. Never inherit cloud / Compose
    # / proxy / dotenv variables from a developer's shell.
    environment = {
        key: value for key, value in os.environ.items()
        if key in {"HOME", "PATH", "LANG", "TMPDIR"}
    }
    # Finder/AppleScript has a minimal PATH. Docker's credential helper is in
    # /usr/local/bin on Docker Desktop, even on Apple Silicon.
    environment["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    return environment


def run(args, **kwargs):
    return subprocess.run(args, check=True, env=clean_env(), **kwargs)


def private_write(path, content):
    temporary = path.with_suffix(path.suffix + ".new")
    with temporary.open("w", encoding="utf-8") as stream:
        os.chmod(temporary, 0o600)
        stream.write(content)
    temporary.replace(path)


def validate_config(config):
    if set(config) != ENV_KEYS or not DATABASE_RE.fullmatch(config.get("LOCAL_DB_NAME", "")):
        raise RuntimeError("Ungültige lokale Konfiguration. Keine Dienste verändert.")
    for key in ENV_KEYS - {"LOCAL_DB_NAME"}:
        if not re.fullmatch(r"[0-9a-f]{32,128}", config[key]):
            raise RuntimeError("Ungültiger lokaler Schlüssel. Keine Dienste verändert.")
    return config


def save_config(config):
    validate_config(config)
    private_write(STATE / "runtime.env", "".join(f"{key}={config[key]}\n" for key in sorted(config)))


def initialize():
    STATE.mkdir(mode=0o700, exist_ok=True)
    os.chmod(STATE, 0o700)
    env_path = STATE / "runtime.env"
    if not env_path.exists():
        save_config({
            "LOCAL_DB_NAME": "kalender_test",
            "LOCAL_DB_PASSWORD": secrets.token_hex(24),
            "LOCAL_SECRET_KEY": secrets.token_hex(32),
            "LOCAL_ADMIN_PASSWORD": secrets.token_hex(16),
        })
    config = validate_config(dict(line.split("=", 1) for line in env_path.read_text().splitlines()))
    if not (STATE / "metadata.json").exists():
        save_metadata({"data_label": "Leere Testdatenbank · noch keine Cloud-Daten", "code_revision": "ungebaut"})
    private_write(STATE / "Zugang.txt", (
        "BEG TESTKALENDER — NUR LOKAL\n\n"
        f"Öffnen: {URL}/__local-test__/\n"
        "Benutzer: local-test-admin\n"
        f"Passwort: {config['LOCAL_ADMIN_PASSWORD']}\n\n"
        "Nur für die lokale Testdatenbank. Kein Cloud-Zugang.\n"
        "Nicht weitergeben oder in Git aufnehmen.\n"
    ))
    return config


def save_metadata(metadata):
    # Docker bind mounts a file inode: write in place so a running instance sees
    # refreshed metadata; JSON is tiny and clients can safely retry a read.
    path = STATE / "metadata.json"
    with path.open("w", encoding="utf-8") as stream:
        os.chmod(path, 0o644)  # Contains no credentials; parent remains 0700.
        json.dump(metadata, stream, ensure_ascii=False)


def docker_binary():
    return shutil.which("docker") or "/usr/local/bin/docker"


def docker(*args, **kwargs):
    return run([docker_binary(), "--context", CONTEXT, *args], **kwargs)


def ensure_engine(start=False):
    endpoint = docker("context", "inspect", CONTEXT, "--format", "{{.Endpoints.docker.Host}}", capture_output=True, text=True).stdout.strip()
    expected = f"unix://{Path.home()}/.docker/run/docker.sock"
    if endpoint != expected:
        raise RuntimeError("Docker-Kontext ist nicht die lokale Docker-Desktop-Engine. Abbruch.")
    try:
        docker("info", "--format", "{{.ServerVersion}}", capture_output=True, timeout=5)
        return
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        if start:
            run(["/usr/bin/open", "-g", "-a", "Docker"])
    deadline = time.monotonic() + (120 if start else 1)
    while True:
        try:
            docker("info", "--format", "{{.ServerVersion}}", capture_output=True, timeout=5)
            return
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if time.monotonic() >= deadline:
                raise RuntimeError("Docker Desktop ist nicht bereit. Bitte Docker öffnen.") from None
            time.sleep(2)


def compose(*args, database=None, **kwargs):
    environment = clean_env()
    if database:
        if not DATABASE_RE.fullmatch(database):
            raise RuntimeError("Ungültige lokale Zieldatenbank.")
        environment["LOCAL_DB_NAME"] = database
    return subprocess.run([
        docker_binary(), "--context", CONTEXT, "compose",
        "--project-name", PROJECT, "--env-file", str(STATE / "runtime.env"),
        "--file", str(HERE / "compose.yaml"), *args,
    ], check=True, env=environment, cwd=ROOT, **kwargs)


def fingerprint():
    digest = hashlib.sha256()
    ignored = {"node_modules", "dist", "build", ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", "android", ".git"}
    for directory in [ROOT / "backend", ROOT / "frontend", HERE]:
        for current, dirs, files in os.walk(directory):
            dirs[:] = sorted(d for d in dirs if d not in ignored and not d.endswith(".egg-info"))
            for filename in sorted(files):
                if filename.startswith(".env") or filename.endswith((".log", ".pyc", ".dump", ".backup")):
                    continue
                path = Path(current) / filename
                digest.update(str(path.relative_to(ROOT)).encode())
                digest.update(path.read_bytes())
    return digest.hexdigest()


def local_health():
    try:
        opener = build_opener(ProxyHandler({}))
        with opener.open(URL + "/__local-test__/health", timeout=3) as response:
            return json.load(response).get("environment") == "isolated-local-test"
    except (URLError, ValueError, TimeoutError):
        return False


def start(rebuild=False, open_browser=False):
    ensure_engine(start=True)
    current = fingerprint()
    previous = (STATE / "build-fingerprint").read_text() if (STATE / "build-fingerprint").exists() else ""
    exists = compose("images", "-q", "app", capture_output=True, text=True).stdout.strip()
    if rebuild or current != previous or not exists:
        print("Testkalender: aktuellen Programmstand lokal bauen …", flush=True)
        compose("build", "app")
        private_write(STATE / "build-fingerprint", current)
    metadata = json.loads((STATE / "metadata.json").read_text())
    revision = run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    metadata["code_revision"] = f"{revision} / {current[:8]}"
    save_metadata(metadata)
    print("Testkalender: lokale Datenbank und Anwendung starten …", flush=True)
    compose("up", "-d", "--wait", "--wait-timeout", "240")
    if not local_health():
        raise RuntimeError("Lokaler Sicherheitstest/Healthcheck fehlgeschlagen. Browser bleibt geschlossen.")
    print(f"Bereit: {URL}/__local-test__/", flush=True)
    if open_browser:
        run(["/usr/bin/open", URL + "/__local-test__/"])


def import_snapshot(path, config, snapshot_date):
    path = path.expanduser().resolve(strict=True)
    with path.open("rb") as stream:
        if stream.read(5) != b"PGDMP":
            raise RuntimeError("Nur PostgreSQL-Custom-Backups (pg_dump -Fc) werden akzeptiert.")
    ensure_engine()
    compose("up", "-d", "--wait", "db")
    database = "kalender_test_" + secrets.token_hex(8)
    # A bad/too-new dump cannot modify the active test database. Retained failed
    # imports are also never dropped automatically.
    with path.open("rb") as stream:
        compose("exec", "-T", "db", "pg_restore", "--list", stdin=stream, stdout=subprocess.DEVNULL)
    compose("exec", "-T", "db", "createdb", "-U", "kalender_test", "-O", "kalender_test", database)
    print("Import in eine neue, ausschließlich lokale Datenbank …", flush=True)
    with path.open("rb") as stream:
        compose("exec", "-T", "db", "pg_restore", "-U", "kalender_test", "--no-owner", "--no-acl", "--exit-on-error", "--single-transaction", "-d", database, stdin=stream)
    compose("run", "--rm", "--no-deps", "app", "python", "/app/local_calendar/runtime.py", "prepare", database=database)
    old_metadata = json.loads((STATE / "metadata.json").read_text())
    new_config = {**config, "LOCAL_DB_NAME": database}
    # Stop only this app; existing local development DBs/containers are unrelated.
    compose("stop", "app")
    try:
        save_config(new_config)
        save_metadata({**old_metadata, "data_label": f"Datenkopie vom {snapshot_date} · importiert {datetime.now():%d.%m.%Y %H:%M}"})
        compose("up", "-d", "--wait", "--wait-timeout", "240", "gateway")
        if not local_health():
            raise RuntimeError("Importierter Teststand nicht gesund.")
    except Exception:
        save_config(config)
        save_metadata(old_metadata)
        compose("up", "-d", "--wait", "--wait-timeout", "240", "gateway")
        raise
    print(f"Lokale Kopie aktiv. Vorherige Testdaten bleiben in {config['LOCAL_DB_NAME']} erhalten.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ["start", "rebuild"]:
        sub = commands.add_parser(name)
        sub.add_argument("--open", action="store_true")
    for name in ["stop", "status", "credentials", "install-dock"]:
        commands.add_parser(name)
    sub = commands.add_parser("import")
    sub.add_argument("backup", type=Path)
    sub.add_argument("--snapshot-date", required=True, type=lambda value: datetime.strptime(value, "%Y-%m-%d").strftime("%d.%m.%Y"))
    sub.add_argument("--replace-local-data", action="store_true", help="Neue Testdaten aktivieren; vorherige lokale Datenbank behalten.")
    args = parser.parse_args()
    config = initialize()
    with (STATE / "manager.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Ein Testkalender-Start/Import läuft bereits. Bitte kurz warten.") from None
        if args.command in {"start", "rebuild"}:
            start(rebuild=args.command == "rebuild", open_browser=args.open)
        elif args.command == "stop":
            ensure_engine()
            compose("stop")
            print("Nur der Testkalender wurde gestoppt. Daten bleiben erhalten.")
        elif args.command == "status":
            ensure_engine()
            compose("ps")
            print(json.loads((STATE / "metadata.json").read_text())["data_label"])
        elif args.command == "credentials":
            run(["/usr/bin/open", str(STATE / "Zugang.txt")])
        elif args.command == "install-dock":
            from install_macos import install
            install(ROOT, STATE)
        elif args.command == "import":
            if not args.replace_local_data:
                raise RuntimeError("Import noch nicht bestätigt: --replace-local-data erforderlich. Nur vertrauenswürdige Backups verwenden.")
            import_snapshot(args.backup, config, args.snapshot_date)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(f"Testkalender: {error}", file=sys.stderr)
        sys.exit(1)
