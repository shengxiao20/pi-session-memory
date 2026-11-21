"""Exact global cosine search, maximum chunk per turn, original snapshot results."""
from pathlib import Path

import numpy as np

from .storage import read_only, validate_complete


def search(index_db, query, client, top_k=10):
    if not query.strip() or top_k <= 0:
        raise ValueError("query must contain text and top-k must be positive")
    with read_only(index_db) as db:
        info = validate_complete(db)
        if client.profile() != info["profile"]:
            raise ValueError("query model profile differs from the index; rebuild explicitly")
        query_vector = client.embed([query])[0]
        if query_vector.shape != (1024,) or not np.isfinite(query_vector).all():
            raise ValueError("query embedding must have 1024 finite dimensions")
        if client.profile() != info["profile"]:
            raise ValueError("query model profile changed during embedding")
        parts = db.execute("SELECT * FROM chunks ORDER BY chunk_id").fetchall()
        matrix = np.stack([np.frombuffer(part["embedding"], dtype="<f4") for part in parts])
        if not np.isfinite(matrix).all() or not np.allclose(np.linalg.norm(matrix, axis=1), 1.0, atol=1e-5):
            raise ValueError("stored vectors must be finite and unit-normalized")
        similarities = np.einsum("ij,j->i", matrix, query_vector, dtype=np.float64)
        if not np.isfinite(similarities).all():
            raise ValueError("cosine calculation produced non-finite scores")
        similarities = np.clip(similarities, -1.0, 1.0)
        winners = {}
        for part, similarity in zip(parts, similarities):
            turn_id = part["turn_id"]
            if turn_id not in winners or similarity > winners[turn_id][1]:
                winners[turn_id] = (part, float(similarity))
        results = []
        for turn_id, (part, similarity) in winners.items():
            turn = dict(db.execute("SELECT * FROM turns WHERE turn_id=?", (turn_id,)).fetchone())
            turn.pop("text_hash")
            results.append({**turn, "similarity": similarity, "best_chunk": {
                "ordinal": part["ordinal"], "start": part["start"], "end": part["end"], "text": part["text"]}})
        results.sort(key=lambda result: (-result["similarity"], -result["ts"], result["turn_id"]))
        results = [{"rank": rank, **result} for rank, result in enumerate(results[:top_k], 1)]
        return {"query": query, "index_db": str(Path(index_db).expanduser().resolve()),
            "snapshot_at": info["snapshot_at"], "source_fingerprint": info["source_fingerprint"],
            "profile": info["profile"], "aggregation": info["aggregation"], "results": results}
