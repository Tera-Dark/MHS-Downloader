"""Deterministic, flat release packaging tests; stdlib only."""

from pathlib import Path
from zipfile import ZipFile
import hashlib
import importlib.util
import json
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "release_packager", ROOT / "tools/package.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleasePackageTests(unittest.TestCase):
    def test_flat_complete_and_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = module.build(Path(tmp) / "first.zip")
            b = module.build(Path(tmp) / "second.zip")
            self.assertEqual(a.read_bytes(), b.read_bytes())
            with ZipFile(a) as archive:
                names = archive.namelist()
                self.assertIn("manifest.json", names)
                self.assertIn("LICENSE.txt", names)
                self.assertTrue(
                    all("/" not in name and "\\" not in name for name in names)
                )
                manifest = json.loads(archive.read("manifest.json"))
                self.assertEqual(
                    manifest["version"],
                    json.loads((ROOT / "package.json").read_text())["version"],
                )
                self.assertIsNone(archive.testzip())
                for name in (
                    "manager.js",
                    "qol.js",
                    "ui-model.js",
                    "zip.js",
                    "icon128.png",
                    "privacy.html",
                ):
                    self.assertEqual(
                        archive.read(name), (ROOT / "extension" / name).read_bytes()
                    )
                self.assertFalse(
                    any(
                        "test" in name or name.endswith((".pem", ".key"))
                        for name in names
                    )
                )
            self.assertIn(
                hashlib.sha256(a.read_bytes()).hexdigest(),
                a.with_suffix(".zip.sha256").read_text(),
            )


if __name__ == "__main__":
    unittest.main()
