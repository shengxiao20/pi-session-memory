import argparse
from contextlib import closing
import os
from pathlib import Path
import sqlite3


def _export_user_prompts(database_path: Path, output_path: Path) -> None:
    with closing(sqlite3.connect(database_path.resolve().as_uri() + "?mode=ro", uri=True)) as database:
        prompts = database.execute(
            "SELECT user_text FROM turns ORDER BY ts, session_id, turn_index, turn_id"
        )
        content = "\n\n".join(row[0] for row in prompts)
    with output_path.open("w", encoding="utf-8", newline="") as output:
        output.write(content)


def main() -> None:
    parser = argparse.ArgumentParser(description="Export user prompts to Markdown.")
    parser.add_argument(
        "--db",
        type=Path,
        default=Path(os.environ.get("MEMORY_DB_PATH", str(Path.home() / ".pi/agent/memory.db"))),
    )
    parser.add_argument(
        "--output", type=Path, default=Path(__file__).resolve().with_name("user-prompts.md")
    )
    args = parser.parse_args()
    _export_user_prompts(args.db, args.output)


if __name__ == "__main__":
    main()
