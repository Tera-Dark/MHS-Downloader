"""Export the GitHub-ready source tree, excluding builds, private inputs and browser data."""

from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
FOLDERS = {"extension", "design", "docs", "tests", "tools", ".github"}
FILES = {
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "package.json",
    "package-lock.json",
    "requirements-dev.txt",
    "requirements-design.txt",
    "requirements-format.txt",
    ".gitignore",
    ".gitattributes",
    ".editorconfig",
    ".prettierrc.json",
}
EXCLUDED = {
    "__pycache__",
    ".cache",
    "node_modules",
    ".git",
    "artifacts",
    ".venv",
    ".pytest_cache",
    "downloads",
    "private-data",
    "user-data",
    "playwright-report",
    "test-results",
}


def build():
    output = ROOT / "artifacts" / "artwork-archive-github.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    inventory = []
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for file in sorted(ROOT.rglob("*")):
            if not file.is_file():
                continue
            rel = file.relative_to(ROOT)
            if any(part in EXCLUDED for part in rel.parts):
                continue
            if not (rel.parts[0] in FOLDERS or str(rel) in FILES):
                continue
            if file.is_symlink():
                raise ValueError(f"Symlink is not allowed in source export: {rel}")
            if file.name.startswith(".env"):
                raise ValueError(f"Environment file is not allowed: {rel}")
            if file.suffix.lower() in {".pem", ".key", ".log", ".zip", ".pyc"}:
                raise ValueError(
                    f"Unexpected private/generated file in source allowlist: {rel}"
                )
            archive.write(file, "artwork-archive/" + rel.as_posix())
            inventory.append(
                {
                    "path": rel.as_posix(),
                    "sha256": hashlib.sha256(file.read_bytes()).hexdigest(),
                }
            )
    (ROOT / "artifacts/source-inventory.json").write_text(
        json.dumps(inventory, indent=2), encoding="utf-8"
    )
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix(".zip.sha256").write_text(
        f"{digest}  {output.name}\n", encoding="utf-8"
    )
    print(
        f"{output}\n{len(inventory)} source files; generated artifacts and private inputs excluded."
    )
    return output


if __name__ == "__main__":
    build()
