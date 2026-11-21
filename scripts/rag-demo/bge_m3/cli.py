"""Manual experiment CLI; no Pi registration or automatic service management."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys

from .embedding import BgeM3Client
from .query import search
from .storage import build_index, read_only, validate_complete


def _parser():
    parser = argparse.ArgumentParser(prog="rag-demo", description="Independent BGE-M3 experiment: vectorize an existing SQLite snapshot, then compare semantic query results. No Jev or plugin integration.")
    commands = parser.add_subparsers(dest="command", required=True)
    index = commands.add_parser("index", help="Vectorize every existing turn into a separate SQLite index; source stays read-only.", description="Build all turn chunks with installed local BGE-M3. Use --replace only to explicitly replace a previous experiment index.")
    index.add_argument("--source-db", type=Path, default=Path(os.environ.get("MEMORY_DB_PATH", str(Path.home() / ".pi/agent/memory.db"))))
    index.add_argument("--batch-size", type=int, default=8)
    index.add_argument("--chunk-bytes", type=int, default=4096)
    index.add_argument("--overlap-bytes", type=int, default=512)
    index.add_argument("--replace", action="store_true", help="Explicitly replace the experiment index after a complete successful build.")
    query = commands.add_parser("query", help="Embed your complete query and return globally similar turns from the experiment snapshot.", description="Exact cosine search with maximum chunk score per turn. No literal matches, reranker, Jev, consultation or writes.")
    query.add_argument("query", help="Your complete user query, preserved verbatim.")
    query.add_argument("--top-k", type=int, default=10)
    query.add_argument("--json", action="store_true", help="Return full original turn text, matching chunk, scores and model provenance as JSON.")
    commands.add_parser("info", help="Inspect snapshot coverage and model provenance without contacting Ollama.", description="Read the complete standalone index metadata; use before comparing results or rebuilding.")
    for command in commands.choices.values():
        command.add_argument("--index-db", type=Path, default=Path.home() / ".pi/agent/experiments/bge-m3.sqlite")
    for command in (index, query):
        command.add_argument("--base-url", default="http://127.0.0.1:11434", help="Running local Ollama HTTP root; no automatic startup or download.")
        command.add_argument("--timeout", type=float, default=300, help="HTTP timeout in seconds; failures propagate without retry.")
    return parser


def _render(result):
    print(f"BGE-M3 · {len(result['results'])} turns · max chunk cosine · snapshot {result['snapshot_at']}")
    print(f"Query: {result['query']}")
    for turn in result["results"]:
        timestamp = datetime.fromtimestamp(turn["ts"] / 1000, timezone.utc).isoformat()
        print(f"\n#{turn['rank']} cosine={turn['similarity']:.6f} · {timestamp}")
        print(f"turn_id: {turn['turn_id']}\nsession_id: {turn['session_id']}\ncwd: {turn['cwd']}")
        print(f"best chunk: {turn['best_chunk']['ordinal']} · character offsets {turn['best_chunk']['start']}..{turn['best_chunk']['end']}")
        print("Match preview (first 500 characters; use --json for full text):")
        print(turn["best_chunk"]["text"][:500])


def main(argv=None):
    args = _parser().parse_args(argv)
    if args.command == "info":
        with read_only(args.index_db) as db:
            result = validate_complete(db)
    elif args.command == "index":
        client = BgeM3Client(args.base_url, args.timeout)
        result = build_index(args.source_db, args.index_db, client, args.batch_size,
            args.chunk_bytes, args.overlap_bytes, args.replace,
            progress=lambda message: print(message, file=sys.stderr, flush=True))
    else:
        client = BgeM3Client(args.base_url, args.timeout)
        result = search(args.index_db, args.query, client, args.top_k)
        if not args.json:
            _render(result)
            return
    print(json.dumps(result, ensure_ascii=False, indent=2))
