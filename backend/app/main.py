from fastapi import FastAPI
from sqlalchemy import text
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import (
    absences,
    admin_integrations,
    assignments,
    auth,
    customers,
    dashboard,
    exports,
    health,
    matrix,
    me,
    persons,
    project_folders,
    sites,
    users,
)
from app.core.config import settings
from app.core.database import SessionLocal, engine
from app.seed_admin import seed_admin


def ensure_site_status_enum_values() -> None:
    if engine.dialect.name != "postgresql":
        return
    statements = [
        "ALTER TYPE site_status ADD VALUE IF NOT EXISTS 'planned'",
        "ALTER TYPE site_status ADD VALUE IF NOT EXISTS 'completed'",
        "ALTER TYPE site_status ADD VALUE IF NOT EXISTS 'deleted'",
        "UPDATE sites SET status = 'completed' WHERE status IN ('closed', 'archived')",
    ]
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        for statement in statements:
            connection.execute(text(statement))


def create_app() -> FastAPI:
    app = FastAPI(title="Baustellenplaner API", version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(auth.router, prefix="/api")
    app.include_router(admin_integrations.router, prefix="/api")
    app.include_router(customers.router, prefix="/api")
    app.include_router(dashboard.router, prefix="/api")
    app.include_router(health.router, prefix="/api", tags=["health"])
    app.include_router(users.router, prefix="/api")
    app.include_router(persons.router, prefix="/api")
    app.include_router(sites.router, prefix="/api")
    app.include_router(project_folders.router, prefix="/api")
    app.include_router(assignments.router, prefix="/api")
    app.include_router(absences.router, prefix="/api")
    app.include_router(exports.router, prefix="/api")
    app.include_router(matrix.router, prefix="/api")
    app.include_router(me.router, prefix="/api")

    @app.on_event("startup")
    def ensure_startup_state() -> None:
        ensure_site_status_enum_values()
        if not settings.admin_username or not settings.admin_password:
            return
        with SessionLocal() as db:
            seed_admin(db)

    return app


app = create_app()
