"""Check the manual demo entry point and npm exclusion without model access."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


DEMO = Path(__file__).resolve().parents[1]
PROJECT = DEMO.parent.parent


class DistributionTests(unittest.TestCase):
    @staticmethod
    def _pack(directory):
        result = subprocess.run(
            ["npm", "pack", "--dry-run", "--json", "--ignore-scripts"],
            cwd=directory, check=True, capture_output=True, text=True, timeout=60,
        )
        return {entry["path"] for entry in json.loads(result.stdout)[0]["files"]}

    def test_directory_entry_point_works_outside_checkout(self):
        with tempfile.TemporaryDirectory(prefix="rag-demo-entry-") as directory:
            result = subprocess.run(
                [sys.executable, str(DEMO), "--help"], cwd=directory,
                check=True, capture_output=True, text=True, timeout=30,
            )
        self.assertIn("usage: rag-demo", result.stdout)
        self.assertIn("{index,query,info}", result.stdout)
        self.assertIn("No Jev or plugin integration.", result.stdout)

    def test_actual_npm_package_excludes_demo_and_old_experiment(self):
        files = self._pack(PROJECT)
        self.assertIn("package.json", files)
        self.assertIn("extensions/index.ts", files)
        self.assertFalse(any(path.startswith(("scripts/rag-demo/", "experiments/")) for path in files))

    def test_nested_npmignore_excludes_demo_when_scripts_are_packaged(self):
        with tempfile.TemporaryDirectory(prefix="rag-demo-pack-") as directory:
            root = Path(directory)
            demo = root / "scripts/rag-demo"
            demo.mkdir(parents=True)
            shutil.copyfile(DEMO / ".npmignore", demo / ".npmignore")
            (root / "package.json").write_text(json.dumps({
                "name": "rag-demo-pack-fixture", "version": "1.0.0", "files": ["scripts/"],
            }))
            (root / "scripts/published.js").write_text("// Published script fixture.\n")
            for name in ["__main__.py", "README.md", "requirements.txt"]:
                (demo / name).write_text("Excluded demo fixture.\n")
            (demo / "bge_m3").mkdir()
            (demo / "bge_m3/storage.py").write_text("# Excluded implementation fixture.\n")
            files = self._pack(root)
        self.assertIn("scripts/published.js", files)
        self.assertFalse(any(path.startswith("scripts/rag-demo/") for path in files))


if __name__ == "__main__":
    unittest.main()
