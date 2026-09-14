"""Build a deterministic, flat extension ZIP. No third-party Python dependencies.
Usage: python tools/package.py [--output artifacts/ArtworkArchive-VERSION.zip]
"""

from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import argparse
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
EXT = ROOT / "extension"


def build(output=None):
    manifest = json.loads((EXT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    assert version == json.loads((ROOT / "package.json").read_text())["version"]
    destination = (
        Path(output) if output else ROOT / "artifacts" / f"ArtworkArchive-{version}.zip"
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    files = {
        f.name: f for f in EXT.iterdir() if f.is_file() and not f.name.startswith(".")
    }
    files["LICENSE.txt"] = ROOT / "LICENSE"
    required = [
        "manifest.json",
        manifest["background"]["service_worker"],
        "manager.html",
        "manager.js",
        "core-policy.js",
        "qol.js",
        "ui-model.js",
        "scanner.js",
        "zip.js",
        "style.css",
        "help.html",
        "privacy.html",
        *manifest["icons"].values(),
    ]
    assert all(name in files for name in required), "Missing release files"
    allowed = {".js", ".css", ".html", ".json", ".png", ".txt"}
    assert all(
        Path(name).suffix in allowed for name in files
    ), "Unexpected file in extension directory"
    with ZipFile(destination, "w", ZIP_DEFLATED) as archive:
        for name, file in sorted(files.items()):
            assert "/" not in name and "\\" not in name
            entry = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, file.read_bytes())
    with ZipFile(destination) as archive:
        assert archive.testzip() is None
        assert "manifest.json" in archive.namelist()
        assert all("/" not in name for name in archive.namelist())
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix(".zip.sha256").write_text(
        f"{digest}  {destination.name}\n", encoding="utf-8"
    )
    print(f"{destination}\nSHA-256 {digest}")
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output")
    args = parser.parse_args()
    build(args.output)
