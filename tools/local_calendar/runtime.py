"""Local-only entrypoint. No changes to production startup or business logic."""

import os
import re
import subprocess
import sys
from urllib.parse import urlparse


def validate_environment(env):
    url = urlparse(env.get("DATABASE_URL", ""))
    if not (
        env.get("LOCAL_TEST_MODE") == "isolated"
        and env.get("ENVIRONMENT") == "local-test"
        and url.scheme == "postgresql+psycopg"
        and url.hostname == "db"
        and url.port == 5432
        and url.username == "kalender_test"
        and re.fullmatch(r"/kalender_test(?:_[0-9a-f]+)?", url.path)
        and not url.query
    ):
        raise RuntimeError("Testkalender verweigert eine nicht-lokale Datenbankkonfiguration.")
    for key in (
        "MS_GRAPH_ENABLED", "MS_GRAPH_CREATE_TEST_FOLDERS_ENABLED",
        "MS_GRAPH_CREATE_PROJECT_FOLDERS_ENABLED", "CTRACK_SYNC_ENABLED",
        "FCM_ENABLED", "PUSH_PLAN_SCHEDULER_ENABLED", "RUN_SEED_DATA",
    ):
        if env.get(key) != "false":
            raise RuntimeError(f"Testkalender: {key} muss deaktiviert sein.")
    for key in (
        "SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM_EMAIL",
        "MS_CLIENT_SECRET", "MS_TENANT_ID", "MS_CLIENT_ID", "CTRACK_BASE_URL",
        "CTRACK_USERNAME", "CTRACK_PASSWORD", "FCM_SERVICE_ACCOUNT_JSON",
        "FCM_SERVICE_ACCOUNT_FILE",
    ):
        if env.get(key):
            raise RuntimeError(f"Testkalender: externe Zugangsdaten ({key}) sind nicht erlaubt.")


def prepare_database():
    validate_environment(os.environ)
    subprocess.run(["alembic", "upgrade", "head"], check=True)
    # A separate, explicit local account, even after restoring a production copy.
    # Existing production users/passwords in the copy are never reset.
    from sqlalchemy import select
    from app.core.database import SessionLocal
    from app.core.security import hash_password
    from app.models.enums import UserRole
    from app.models.user import User

    with SessionLocal() as db:
        existing = db.scalar(select(User).where(User.username == "local-test-admin"))
        if existing is None:
            db.add(User(
                username="local-test-admin",
                display_name="Lokaler Testadministrator",
                password_hash=hash_password(os.environ["ADMIN_PASSWORD"]),
                role=UserRole.ADMIN,
                is_active=True,
                must_change_password=False,
            ))
            db.commit()


if __name__ == "__main__":
    prepare_database()
    if sys.argv[1:] == ["serve"]:
        import uvicorn
        uvicorn.run("server:app", host="0.0.0.0", port=8000, proxy_headers=False)
