"""Fail fast when Azure and project dependency manifests drift apart."""

from __future__ import annotations

import re
import tomllib
from pathlib import Path
from typing import Iterable


BACKEND_ROOT = Path(__file__).resolve().parents[2]
REQUIREMENT_PATTERN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)(.*)$")


def _normalize_requirement(requirement: str) -> tuple[str, str]:
    value = requirement.split("#", 1)[0].strip()
    match = REQUIREMENT_PATTERN.fullmatch(value)
    if not match:
        raise ValueError(f"Nicht unterstützte Dependency-Angabe: {requirement!r}")
    name, constraint = match.groups()
    canonical_name = re.sub(r"[-_.]+", "-", name).casefold()
    normalized_constraint = re.sub(r"\s+", "", constraint).casefold()
    return canonical_name, normalized_constraint


def _dependency_map(requirements: Iterable[str]) -> dict[str, str]:
    dependencies: dict[str, str] = {}
    for requirement in requirements:
        if not requirement.strip() or requirement.lstrip().startswith("#"):
            continue
        name, constraint = _normalize_requirement(requirement)
        if name in dependencies:
            raise ValueError(f"Dependency {name!r} ist mehrfach definiert.")
        dependencies[name] = constraint
    return dependencies


def dependency_drift(
    project_requirements: Iterable[str],
    azure_requirements: Iterable[str],
) -> list[str]:
    project = _dependency_map(project_requirements)
    azure = _dependency_map(azure_requirements)
    messages: list[str] = []
    for name in sorted(project.keys() | azure.keys()):
        if name not in azure:
            messages.append(f"{name}: fehlt in requirements.txt")
        elif name not in project:
            messages.append(f"{name}: fehlt in pyproject.toml")
        elif project[name] != azure[name]:
            messages.append(
                f"{name}: unterschiedliche Constraints "
                f"(pyproject {project[name]!r}, requirements {azure[name]!r})"
            )
    return messages


def check_runtime_dependencies(root: Path = BACKEND_ROOT) -> None:
    with (root / "pyproject.toml").open("rb") as pyproject_file:
        pyproject = tomllib.load(pyproject_file)
    project_requirements = pyproject["project"]["dependencies"]
    azure_requirements = (root / "requirements.txt").read_text(encoding="utf-8").splitlines()
    drift = dependency_drift(project_requirements, azure_requirements)
    if drift:
        raise SystemExit(
            "Runtime-Dependencies sind nicht synchron:\n- " + "\n- ".join(drift)
        )


if __name__ == "__main__":
    check_runtime_dependencies()
    print("pyproject.toml und requirements.txt sind synchron.")
