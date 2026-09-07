import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    sys.modules[name] = result
    spec.loader.exec_module(result)
    return result


manage = module("manage")
runtime = module("runtime")


def safe_environment():
    return {
        "LOCAL_TEST_MODE": "isolated", "ENVIRONMENT": "local-test",
        "DATABASE_URL": "postgresql+psycopg://kalender_test:secret@db:5432/kalender_test",
        **{key: "false" for key in (
            "MS_GRAPH_ENABLED", "MS_GRAPH_CREATE_TEST_FOLDERS_ENABLED",
            "MS_GRAPH_CREATE_PROJECT_FOLDERS_ENABLED", "CTRACK_SYNC_ENABLED",
            "FCM_ENABLED", "PUSH_PLAN_SCHEDULER_ENABLED", "RUN_SEED_DATA",
        )},
    }


class SafetyTests(unittest.TestCase):
    def test_local_environment_allowed(self):
        runtime.validate_environment(safe_environment())

    def test_cloud_wrong_database_and_url_overrides_rejected(self):
        for url in (
            "postgresql+psycopg://kalender_test:secret@cloud.example:5432/kalender_test",
            "postgresql+psycopg://kalender_test:secret@db:5432/production",
            "postgresql+psycopg://kalender_test:secret@db:5432/kalender_test?host=cloud.example",
            "postgresql+psycopg://other:secret@db:5432/kalender_test",
            "sqlite:///:memory:",
        ):
            with self.subTest(url=url), self.assertRaises(RuntimeError):
                runtime.validate_environment({**safe_environment(), "DATABASE_URL": url})

    def test_integration_or_scheduler_enabled_rejected(self):
        for key, value in safe_environment().items():
            if value == "false":
                with self.subTest(key=key), self.assertRaises(RuntimeError):
                    runtime.validate_environment({**safe_environment(), key: "true"})

    def test_external_secrets_rejected(self):
        for key in ["SMTP_HOST", "MS_CLIENT_SECRET", "CTRACK_USERNAME", "FCM_SERVICE_ACCOUNT_JSON"]:
            with self.subTest(key=key), self.assertRaises(RuntimeError):
                runtime.validate_environment({**safe_environment(), key: "not-a-real-secret"})

    def test_no_implicit_local_mode(self):
        with self.assertRaises(RuntimeError):
            runtime.validate_environment({**safe_environment(), "LOCAL_TEST_MODE": ""})

    def test_shell_environment_does_not_leak(self):
        with patch.dict(os.environ, {
            "DATABASE_URL": "cloud", "COMPOSE_FILE": "other.yaml", "DOCKER_HOST": "tcp://remote",
            "LOCAL_DB_NAME": "production", "HTTP_PROXY": "http://remote", "VITE_API_BASE_URL": "cloud",
        }):
            self.assertTrue(set(manage.clean_env()) <= {"HOME", "PATH", "LANG", "TMPDIR"})

    def test_finder_path_includes_docker_credential_helper(self):
        with patch.dict(os.environ, {"PATH": "/usr/bin:/bin"}):
            self.assertIn("/usr/local/bin", manage.clean_env()["PATH"].split(":"))

    def test_runtime_and_database_are_on_internal_network_only(self):
        compose = (HERE / "compose.yaml").read_text()
        self.assertEqual(compose.count("networks: [isolated]"), 2)
        self.assertIn("internal: true", compose)
        self.assertIn("'127.0.0.1:18727:8080'", compose)
        self.assertEqual(compose.count("ports:"), 1)
        self.assertIn("read_only: true", compose)
        self.assertNotIn("docker.sock", compose)
        self.assertNotIn("env_file:", compose)
        self.assertNotIn("5432:5432", compose)
        self.assertIn("networks: [entrance, isolated]", compose)
        self.assertIn("set $local_app http://app:8000", (HERE / "nginx.conf").read_text())

    def test_build_excludes_developer_credentials(self):
        ignore = (HERE / "Dockerfile.dockerignore").read_text()
        self.assertIn("**/.env", ignore)
        self.assertIn("**/.env.*", ignore)
        self.assertIn("**/*firebase-adminsdk*", ignore)
        self.assertIn("ENV VITE_API_BASE_URL=/api", (HERE / "Dockerfile").read_text())

    def test_shell_keeps_app_viewport_separate_and_never_inserts_credentials(self):
        html = (HERE / "index.html").read_text()
        css = (HERE / "assets/shell.css").read_text()
        self.assertIn("TESTKALENDER", html)
        self.assertIn('<iframe src="/"', html)
        self.assertIn("min-height: 0", css)
        self.assertIn("height: 100dvh", css)
        self.assertNotIn("password", html)
        self.assertIn("connect-src 'self'", (HERE / "server.py").read_text())


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.state = Path(self.temporary.name) / "state"
        self.override = patch.object(manage, "STATE", self.state)
        self.override.start()
        self.addCleanup(self.override.stop)
        self.config = manage.initialize()

    def test_initialization_is_private_idempotent_and_has_no_cloud_data(self):
        self.assertEqual(self.config, manage.initialize())
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual((self.state / "runtime.env").stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.state / "Zugang.txt").stat().st_mode & 0o777, 0o600)
        self.assertIn("noch keine Cloud-Daten", (self.state / "metadata.json").read_text())
        self.assertNotIn(self.config["LOCAL_ADMIN_PASSWORD"], (self.state / "metadata.json").read_text())

    def test_unknown_configuration_and_nonlocal_database_rejected(self):
        for updated in [{"OTHER": "anything"}, {"LOCAL_DB_NAME": "production"}, {"LOCAL_DB_PASSWORD": "bad\nDATABASE_URL=cloud"}]:
            with self.subTest(updated=updated), self.assertRaises(RuntimeError):
                manage.save_config({**self.config, **updated})

    def test_invalid_dump_does_not_touch_docker(self):
        source = self.state / "bad.dump"
        source.write_bytes(b"not a database backup")
        with patch.object(manage, "compose") as compose, self.assertRaises(RuntimeError):
            manage.import_snapshot(source, self.config, "07.09.2026")
        compose.assert_not_called()

    def test_failed_restore_never_switches_active_database(self):
        source = self.state / "valid.dump"
        source.write_bytes(b"PGDMPfixture")
        calls = []

        def compose(*args, **kwargs):
            calls.append(args)
            if "--single-transaction" in args:
                raise RuntimeError("restore failed")

        with patch.object(manage, "ensure_engine"), patch.object(manage, "compose", side_effect=compose), self.assertRaises(RuntimeError):
            manage.import_snapshot(source, self.config, "07.09.2026")
        self.assertEqual(manage.initialize(), self.config)
        self.assertFalse(any("stop" in call for call in calls))

    def test_successful_import_uses_new_database_and_retains_old_one(self):
        source = self.state / "valid.dump"
        source.write_bytes(b"PGDMPfixture")
        with patch.object(manage, "ensure_engine"), patch.object(manage, "compose") as compose, patch.object(manage, "local_health", return_value=True):
            manage.import_snapshot(source, self.config, "07.09.2026")
        changed = manage.initialize()
        self.assertNotEqual(changed["LOCAL_DB_NAME"], self.config["LOCAL_DB_NAME"])
        self.assertNotEqual(changed["LOCAL_SECRET_KEY"], self.config["LOCAL_SECRET_KEY"])
        self.assertEqual(changed["LOCAL_ADMIN_PASSWORD"], self.config["LOCAL_ADMIN_PASSWORD"])
        self.assertTrue(manage.DATABASE_RE.fullmatch(changed["LOCAL_DB_NAME"]))
        self.assertNotIn("dropdb", str(compose.call_args_list))
        self.assertNotIn("--clean", str(compose.call_args_list))
        self.assertNotIn("--create", str(compose.call_args_list))
        self.assertIn("07.09.2026", json.loads((self.state / "metadata.json").read_text())["data_label"])

    def test_failed_app_after_import_rolls_back_only_local_config(self):
        source = self.state / "valid.dump"
        source.write_bytes(b"PGDMPfixture")
        old_metadata = (self.state / "metadata.json").read_text()
        with patch.object(manage, "ensure_engine"), patch.object(manage, "compose"), patch.object(manage, "local_health", return_value=False), self.assertRaises(RuntimeError):
            manage.import_snapshot(source, self.config, "07.09.2026")
        self.assertEqual(manage.initialize(), self.config)
        self.assertEqual((self.state / "metadata.json").read_text(), old_metadata)


if __name__ == "__main__":
    unittest.main()
