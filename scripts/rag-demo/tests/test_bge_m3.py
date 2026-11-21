"""Isolated BGE-M3 experiment tests; no model service, history or config writes."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bge_m3.chunking import chunks, document
from bge_m3.cli import main
from bge_m3.embedding import BgeM3Client, DIMENSION, MODEL
from bge_m3.query import search
from bge_m3.storage import build_index, read_only, snapshot, validate_complete


class FakeClient:
    def __init__(self):
        self.inputs = []

    def profile(self):
        return {"model": MODEL, "digest": "fixture-digest", "dimension": DIMENSION}

    def embed(self, texts):
        self.inputs.extend(texts)
        rows = []
        for text in texts:
            row = np.zeros(DIMENSION, dtype=np.float32)
            if "NEEDLE" in text or text == "question":
                row[0] = 1
            else:
                row[1] = 1
            rows.append(row)
        return np.stack(rows)


class BgeM3ExperimentTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="bge-m3-test-")
        self.addCleanup(self.directory.cleanup)
        self.source = Path(self.directory.name) / "source.sqlite"
        self.index = Path(self.directory.name) / "vectors.sqlite"
        with sqlite3.connect(self.source) as db:
            db.executescript("CREATE TABLE sessions(session_id TEXT PRIMARY KEY, cwd TEXT, source TEXT); CREATE TABLE turns(turn_id TEXT PRIMARY KEY, session_id TEXT, turn_index INTEGER, ts INTEGER, user_text TEXT, reply_text TEXT);")
            db.execute("INSERT INTO sessions VALUES ('pi:s', '/fixture', 'pi')")
            db.executemany("INSERT INTO turns VALUES (?,?,?,?,?,?)", [
                ("A", "pi:s", 0, 1000, "字🙂" * 300, "late NEEDLE evidence"),
                ("B", "pi:s", 1, 2000, "other topic", "reply"),
                ("C", "pi:s", 2, 3000, "NEEDLE", "a short match"),
            ])
        self.source_hash = hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.client = FakeClient()

    def _build(self, **options):
        return build_index(self.source, self.index, self.client, max_bytes=64, overlap_bytes=8, progress=lambda message: None, **options)

    def test_unicode_chunks_cover_every_character_and_have_safe_overlap(self):
        text = "字🙂abc\"\\\n" * 400
        for budget, overlap in ((32, 0), (32, 28), (4096, 512)):
            parts = list(chunks(text, budget, overlap))
            self.assertEqual(parts[0].start, 0)
            self.assertEqual(parts[-1].end, len(text))
            previous_end = 0
            covered = []
            for ordinal, part in enumerate(parts):
                self.assertEqual(part.ordinal, ordinal)
                self.assertLessEqual(part.start, previous_end)
                self.assertGreater(part.end, previous_end)
                self.assertEqual(part.text, text[part.start:part.end])
                self.assertLessEqual(len(part.text.encode("utf8")), budget)
                self.assertEqual(part.text.encode("utf8").decode("utf8"), part.text)
                covered.append(text[previous_end:part.end])
                previous_end = part.end
            self.assertEqual("".join(covered), text)

    def test_invalid_chunk_parameters_fail(self):
        for budget, overlap in ((0, 0), (4097, 0), (32, -1), (32, 31)):
            with self.assertRaises(ValueError):
                list(chunks("text", budget, overlap))

    def test_source_is_read_only_and_every_turn_is_copied(self):
        with read_only(self.source) as db:
            with self.assertRaises(sqlite3.OperationalError):
                db.execute("DELETE FROM turns")
        info = self._build()
        self.assertEqual(info["turn_count"], 3)
        self.assertGreater(info["chunk_count"], 3)
        with read_only(self.index) as db:
            self.assertEqual(validate_complete(db)["status"], "complete")
            stored = db.execute("SELECT user_text,reply_text FROM turns WHERE turn_id='A'").fetchone()
            self.assertEqual(tuple(stored), ("字🙂" * 300, "late NEEDLE evidence"))
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.source_hash)

    def test_missing_source_never_creates_a_database(self):
        missing = self.source.with_name("missing.sqlite")
        with self.assertRaises(FileNotFoundError):
            snapshot(missing)
        self.assertFalse(missing.exists())

    def test_orphan_turns_fail_instead_of_disappearing(self):
        with sqlite3.connect(self.source) as db:
            db.execute("UPDATE turns SET session_id='missing' WHERE turn_id='B'")
        with self.assertRaisesRegex(ValueError, "every turn"):
            self._build()
        self.assertFalse(self.index.exists())

    def test_source_cannot_be_used_as_output_including_hard_links(self):
        for destination in (self.source, self.source.with_name("hardlink.sqlite")):
            if destination != self.source:
                import os
                os.link(self.source, destination)
            with self.assertRaisesRegex(ValueError, "different files"):
                build_index(self.source, destination, self.client, replace=True)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.source_hash)

    def test_exact_maximum_chunk_ranking_returns_unique_full_turns(self):
        self._build()
        before = hashlib.sha256(self.index.read_bytes()).hexdigest()
        result = search(self.index, "question", self.client, top_k=3)
        self.assertEqual([turn["turn_id"] for turn in result["results"]], ["C", "A", "B"])
        self.assertEqual([turn["similarity"] for turn in result["results"]], [1, 1, 0])
        self.assertGreater(result["results"][1]["best_chunk"]["ordinal"], 0)
        self.assertEqual(result["results"][1]["user_text"], "字🙂" * 300)
        self.assertEqual(result["query"], "question")
        self.assertEqual(hashlib.sha256(self.index.read_bytes()).hexdigest(), before)

    def test_query_is_passed_verbatim_without_prefix(self):
        self._build()
        self.client.inputs.clear()
        search(self.index, "  完整 user query 🙂  ", self.client)
        self.assertEqual(self.client.inputs, ["  完整 user query 🙂  "])

    def test_existing_index_requires_explicit_replace(self):
        self._build()
        with self.assertRaises(FileExistsError):
            self._build()
        self._build(replace=True)

    def test_embedding_failure_leaves_published_index_unchanged(self):
        self._build()
        previous = self.index.read_bytes()
        with patch.object(self.client, "embed", side_effect=RuntimeError("service failed")):
            with self.assertRaisesRegex(RuntimeError, "service failed"):
                self._build(replace=True)
        self.assertEqual(self.index.read_bytes(), previous)
        self.assertTrue(list(Path(self.directory.name).glob("vectors.sqlite.building-*.sqlite")))

    def test_model_digest_changes_fail_on_build_and_query(self):
        self._build()
        different = {**self.client.profile(), "digest": "changed"}
        with patch.object(self.client, "profile", return_value=different):
            with self.assertRaisesRegex(ValueError, "differs"):
                search(self.index, "question", self.client)
        self.index.unlink()
        with patch.object(self.client, "profile", side_effect=[{"model": MODEL}, {"model": "changed"}]):
            with self.assertRaisesRegex(ValueError, "changed during"):
                self._build()
        self.assertFalse(self.index.exists())

    def test_incomplete_and_corrupt_vectors_fail(self):
        self._build()
        with sqlite3.connect(self.index) as db:
            db.execute("UPDATE chunks SET embedding=NULL WHERE chunk_id=1")
        with self.assertRaisesRegex(ValueError, "incomplete"):
            search(self.index, "question", self.client)
        self._build(replace=True)
        with sqlite3.connect(self.index) as db:
            db.execute("UPDATE chunks SET embedding=? WHERE chunk_id=1", (bytes(4096),))
        with self.assertRaisesRegex(ValueError, "unit-normalized"):
            search(self.index, "question", self.client)

    def test_client_forbids_remote_hosts_and_bad_vectors(self):
        for url in ("https://example.com", "http://example.com", "http://u:p@localhost", "http://localhost/api", "http://localhost?x=1"):
            with self.assertRaises(ValueError):
                BgeM3Client(url)
        for rows in ([[0] * 1024], [[float("nan")] * 1024], [[1] * 10], [[1] * 1024, [1] * 1024]):
            with self.assertRaises(ValueError):
                BgeM3Client._normalize(rows, 1)
        vector = BgeM3Client._normalize([[2] * 1024], 1)
        self.assertAlmostEqual(float(np.linalg.norm(vector)), 1)

    def test_wire_input_has_truncate_false_and_fixed_bge_model(self):
        client = BgeM3Client()
        response = {"model": MODEL, "embeddings": [[2] * 1024]}
        with patch.object(client, "_request", return_value=response) as request:
            client.embed(["original"])
        endpoint, payload = request.call_args.args
        self.assertEqual(endpoint, "/api/embed")
        self.assertEqual(payload["input"], ["original"])
        self.assertEqual(payload["model"], MODEL)
        self.assertFalse(payload["truncate"])
        self.assertEqual(payload["options"], {"num_ctx": 8192, "num_batch": 8192})
        self.assertEqual(request.call_count, 1)

    def test_local_requests_disable_proxies_redirects_and_retries(self):
        with patch("bge_m3.embedding.build_opener") as build:
            client = BgeM3Client()
        self.assertEqual(build.call_args.args[0].proxies, {})
        redirect = build.call_args.args[1]
        with self.assertRaisesRegex(RuntimeError, "redirects are disabled"):
            redirect.redirect_request(None, None, 302, "redirect", {}, "http://example.com")
        client._opener.open.side_effect = TimeoutError("request timeout")
        with self.assertRaises(TimeoutError):
            client.embed(["private local input"])
        self.assertEqual(client._opener.open.call_count, 1)

    def test_info_works_without_model_service(self):
        self._build()
        output = io.StringIO()
        with patch("bge_m3.cli.BgeM3Client", side_effect=AssertionError("must not connect")), contextlib.redirect_stdout(output):
            main(["info", "--index-db", str(self.index)])
        self.assertEqual(json.loads(output.getvalue())["turn_count"], 3)


if __name__ == "__main__":
    unittest.main()
