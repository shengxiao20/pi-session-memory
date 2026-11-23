from contextlib import closing
import os
from pathlib import Path
import runpy
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("__main__.py")
_export_user_prompts = runpy.run_path(str(SCRIPT))["_export_user_prompts"]


class ExtractUserPromptTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.database_path = Path(self.directory.name) / "memory #测试.db"
        self.output_path = Path(self.directory.name) / "prompts.md"
        with closing(sqlite3.connect(self.database_path)) as database:
            database.execute(
                "CREATE TABLE turns (turn_id TEXT PRIMARY KEY, session_id TEXT, "
                "turn_index INTEGER, ts INTEGER, user_text TEXT NOT NULL, reply_text TEXT, tool_names TEXT)"
            )

    def _seed(self, rows):
        with closing(sqlite3.connect(self.database_path)) as database:
            database.executemany("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?)", rows)
            database.commit()

    def test_exports_all_prompts_verbatim_in_stable_order(self):
        prompt = "  中文🙂\r\n# 原文\n```python\nprint('hello')\n```  "
        self._seed([
            ("z", "session-z", 0, 2, "duplicate", "REPLY_METADATA", '["recall_memory"]'),
            ("a2", "session-a", 1, 2, "duplicate", "REPLY_METADATA", None),
            ("a1", "session-a", 0, 2, "", "REPLY_METADATA", None),
            ("first", "session-a", 3, 1, prompt, "REPLY_METADATA", None),
        ])
        original = self.database_path.read_bytes()
        _export_user_prompts(self.database_path, self.output_path)
        self.assertEqual(self.output_path.read_bytes(), f"{prompt}\n\n\n\nduplicate\n\nduplicate".encode("utf-8"))
        self.assertEqual(self.database_path.read_bytes(), original)

    def test_empty_database_exports_empty_file(self):
        _export_user_prompts(self.database_path, self.output_path)
        self.assertEqual(self.output_path.read_bytes(), b"")

    def test_missing_database_raises_without_creating_files(self):
        missing = self.database_path.with_name("missing.db")
        with self.assertRaises(sqlite3.OperationalError):
            _export_user_prompts(missing, self.output_path)
        self.assertFalse(missing.exists())
        self.assertFalse(self.output_path.exists())

    def test_invalid_schema_raises_and_preserves_existing_output(self):
        self.output_path.write_text("previous export", encoding="utf-8")
        with closing(sqlite3.connect(self.database_path)) as database:
            database.execute("DROP TABLE turns")
            database.commit()
        with self.assertRaises(sqlite3.OperationalError):
            _export_user_prompts(self.database_path, self.output_path)
        self.assertEqual(self.output_path.read_text(encoding="utf-8"), "previous export")

    def test_cli_uses_environment_database(self):
        self._seed([("id", "session", 0, 1, "用户原文", "assistant reply", None)])
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--output", str(self.output_path)],
            env={**os.environ, "MEMORY_DB_PATH": str(self.database_path)},
            capture_output=True, check=True,
        )
        self.assertEqual(result.stdout, b"")
        self.assertEqual(self.output_path.read_bytes(), "用户原文".encode("utf-8"))

    def test_cli_explicit_database_overrides_environment(self):
        self._seed([("id", "session", 0, 1, "explicit prompt", "assistant reply", None)])
        subprocess.run(
            [sys.executable, str(SCRIPT), "--db", str(self.database_path), "--output", str(self.output_path)],
            env={**os.environ, "MEMORY_DB_PATH": str(self.database_path.with_name("missing.db"))},
            capture_output=True, check=True,
        )
        self.assertEqual(self.output_path.read_bytes(), b"explicit prompt")


if __name__ == "__main__":
    unittest.main()
