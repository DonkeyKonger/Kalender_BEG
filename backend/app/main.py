from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import (
    absences,
    assignments,
    auth,
    health,
    matrix,
    persons,
    sites,
    users,
)
from app.core.config import settings
from app.core.database import SessionLocal
from app.seed_admin import seed_admin


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
    app.include_router(health.router, prefix="/api", tags=["health"])
    app.include_router(users.router, prefix="/api")
    app.include_router(persons.router, prefix="/api")
    app.include_router(sites.router, prefix="/api")
    app.include_router(assignments.router, prefix="/api")
    app.include_router(absences.router, prefix="/api")
    app.include_router(matrix.router, prefix="/api")

    @app.on_event("startup")
    def ensure_admin_user() -> None:
        if not settings.admin_username or not settings.admin_password:
            return
        with SessionLocal() as db:
            seed_admin(db)

    return app


app = create_app()
