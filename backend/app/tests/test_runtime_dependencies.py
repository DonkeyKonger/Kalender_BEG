from app.scripts.check_runtime_dependencies import (
    BACKEND_ROOT,
    check_runtime_dependencies,
    dependency_drift,
)


def test_project_and_azure_runtime_dependencies_match() -> None:
    check_runtime_dependencies(BACKEND_ROOT)


def test_missing_azure_dependency_is_reported() -> None:
    assert dependency_drift(
        ["fastapi>=0.115.0", "reportlab>=4.2.5"],
        ["fastapi>=0.115.0"],
    ) == ["reportlab: fehlt in requirements.txt"]


def test_constraint_drift_is_reported() -> None:
    assert dependency_drift(
        ["reportlab>=4.2.5"],
        ["reportlab==4.2.5"],
    ) == [
        "reportlab: unterschiedliche Constraints "
        "(pyproject '>=4.2.5', requirements '==4.2.5')"
    ]
