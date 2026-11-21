"""Read-only source snapshots and atomic publication of a standalone vector DB."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import tempfile

from .chunking import chunks, document

SCHEMA_VERSION = 1
SCHEMA = """
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE turns (
  turn_id TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL, turn_index INTEGER NOT NULL,
  ts INTEGER NOT NULL, cwd TEXT NOT NULL, source TEXT NOT NULL, user_text TEXT NOT NULL,
  reply_text TEXT NOT NULL, text_hash TEXT NOT NULL
);
CREATE TABLE chunks (
  chunk_id INTEGER PRIMARY KEY, turn_id TEXT NOT NULL REFERENCES turns(turn_id),
  ordinal INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
  text TEXT NOT NULL, embedding BLOB,
  CHECK(embedding IS NULL OR length(embedding) = 4096), UNIQUE(turn_id, ordinal)
);
CREATE INDEX idx_chunks_turn ON chunks(turn_id, ordinal);
"""


@contextmanager
def read_only(path):
    path = Path(path).expanduser().resolve(strict=True)
    db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    try:
        yield db
    finally:
        db.close()


def snapshot(source_db):
    with read_only(source_db) as db:
        db.execute("BEGIN")
        count = db.execute("SELECT count(*) FROM turns").fetchone()[0]
        rows = db.execute("""SELECT t.turn_id, t.session_id, t.turn_index, t.ts, s.cwd,
            s.source, t.user_text, t.reply_text FROM turns t
            JOIN sessions s ON s.session_id=t.session_id ORDER BY t.turn_id""").fetchall()
        if len(rows) != count or count == 0:
            raise ValueError("source must contain turns, and every turn must have its session")
        turns = [dict(row) for row in rows]
    digest = hashlib.sha256(json.dumps(turns, ensure_ascii=False, sort_keys=True).encode("utf8")).hexdigest()
    return turns, digest


def metadata(db):
    return {row["key"]: json.loads(row["value"]) for row in db.execute("SELECT key, value FROM metadata")}


def validate_complete(db):
    info = metadata(db)
    if info["schema_version"] != SCHEMA_VERSION or info["status"] != "complete":
        raise ValueError("vector index must have schema version 1 and complete status")
    turns = db.execute("SELECT count(*) FROM turns").fetchone()[0]
    complete, total = db.execute("SELECT count(embedding), count(*) FROM chunks").fetchone()
    missing = db.execute("SELECT count(*) FROM turns t WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.turn_id=t.turn_id)").fetchone()[0]
    if turns != info["turn_count"] or total != info["chunk_count"] or complete != total or missing:
        raise ValueError("vector index coverage is incomplete")
    return info


def build_index(source_db, index_db, client, batch_size=8, max_bytes=4096, overlap_bytes=512,
                replace=False, progress=print):
    source = Path(source_db).expanduser().resolve(strict=True)
    destination = Path(index_db).expanduser().resolve()
    if source == destination or (destination.exists() and os.path.samefile(source, destination)):
        raise ValueError("source and vector index must be different files")
    if destination.exists() and not replace:
        raise FileExistsError(f"vector index exists: {destination}; use --replace explicitly")
    if batch_size <= 0:
        raise ValueError("batch size must be positive")
    # Validate the chunk profile before model calls or file creation.
    list(chunks("profile", max_bytes, overlap_bytes))
    turns, fingerprint = snapshot(source)
    profile = client.profile()
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=destination.name + ".building-", suffix=".sqlite", dir=destination.parent)
    os.close(descriptor)
    db = sqlite3.connect(temporary)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        db.executescript(SCHEMA)
        info = {"schema_version": SCHEMA_VERSION, "status": "building", "profile": profile,
            "source_db": str(source), "source_fingerprint": fingerprint,
            "snapshot_at": datetime.now(timezone.utc).isoformat(), "turn_count": len(turns),
            "chunk_bytes": max_bytes, "overlap_bytes": overlap_bytes,
            "offset_unit": "python-unicode-code-point", "aggregation": "maximum-chunk-cosine"}
        db.executemany("INSERT INTO metadata VALUES (?, ?)", [(key, json.dumps(value, ensure_ascii=False)) for key, value in info.items()])
        for turn in turns:
            text = document(turn)
            text_hash = hashlib.sha256(text.encode("utf8")).hexdigest()
            db.execute("INSERT INTO turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (*[turn[key] for key in ("turn_id", "session_id", "turn_index", "ts", "cwd", "source", "user_text", "reply_text")], text_hash))
            db.executemany("INSERT INTO chunks(turn_id,ordinal,start,end,text) VALUES (?,?,?,?,?)",
                [(turn["turn_id"], part.ordinal, part.start, part.end, part.text) for part in chunks(text, max_bytes, overlap_bytes)])
        db.commit()
        parts = db.execute("SELECT chunk_id, text FROM chunks ORDER BY chunk_id").fetchall()
        progress(f"snapshot: {len(turns)} turns, {len(parts)} chunks; source read-only")
        for offset in range(0, len(parts), batch_size):
            batch = parts[offset:offset + batch_size]
            vectors = client.embed([part["text"] for part in batch])
            if vectors.shape != (len(batch), 1024):
                raise ValueError("embedding batch has wrong shape")
            db.executemany("UPDATE chunks SET embedding=? WHERE chunk_id=?",
                [(vector.astype("<f4").tobytes(), part["chunk_id"]) for part, vector in zip(batch, vectors)])
            db.commit()
            progress(f"embedded: {offset + len(batch)}/{len(parts)} chunks")
        if client.profile() != profile:
            raise ValueError("model profile changed during indexing")
        db.execute("INSERT INTO metadata VALUES ('chunk_count', ?)", (json.dumps(len(parts)),))
        db.execute("UPDATE metadata SET value=? WHERE key='status'", (json.dumps("complete"),))
        db.commit()
        validate_complete(db)
    except BaseException:
        progress(f"index failed; diagnostic partial DB: {temporary}; published index unchanged")
        raise
    finally:
        db.close()
    os.replace(temporary, destination)
    return {**info, "status": "complete", "chunk_count": len(parts), "index_db": str(destination)}
