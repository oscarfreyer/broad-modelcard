"""Run the API on 127.0.0.1: ``python -m app.serve [--port 8000] [--db FILE] [--uploads-dir DIR]``.

There is deliberately no host option. The API has no authentication
, so it listens on the loopback interface only.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

HOST = "127.0.0.1"


def main(argv: list[str] | None = None) -> int:
    from . import db
    from .main import API_PREFIX, create_app, default_db_path, default_uploads_dir

    parser = argparse.ArgumentParser(prog="python -m app.serve", description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=8000, help="port on 127.0.0.1 (default 8000)")
    parser.add_argument("--db", type=Path, default=None, help="SQLite store (default backend/data/broad_modelcard.sqlite or $BMC_DB)")
    parser.add_argument(
        "--uploads-dir",
        type=Path,
        default=None,
        help="folder for staged upload files (default $BMC_UPLOADS_DIR; else uploads/ next to the live store, <store name>-uploads/ next to any other store)",
    )
    parser.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])
    args = parser.parse_args(argv)

    db_path = (args.db or default_db_path()).resolve()
    if not db_path.is_file():
        print(f"No store at {db_path}.\nBuild it first:  .venv/bin/python -m app.importers.legacy_json", file=sys.stderr)
        return 2

    uploads_dir = args.uploads_dir or default_uploads_dir()
    if uploads_dir is None and db_path != db.DEFAULT_DB_PATH.resolve():
        # Another store next to the live one (the demo store) must never share backend/data/uploads.
        uploads_dir = db_path.with_name(f"{db_path.stem}-uploads")

    import uvicorn

    # The app logs the local-only warning at startup.
    logging.basicConfig(level=args.log_level.upper(), format="%(levelname)s:     %(message)s")
    print(f"Serving http://{HOST}:{args.port}{API_PREFIX} (docs at {API_PREFIX}/docs)", file=sys.stderr)
    uvicorn.run(
        create_app(db_path, uploads_dir=uploads_dir),
        host=HOST,
        port=args.port,
        log_level=args.log_level,
        server_header=False,
        proxy_headers=False,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
