"""``python -m app.demo build [--db FILE] [--uploads-dir DIR] [--pack DIR] [--seed DIR] [--no-import] [--quiet]
[--ontology-sources DIR] [--no-ontologies]``.

Builds the dashboard demo store (default backend/data/dashboard-demo.sqlite):
the seed import, then every demo pack file published through the update
workflow, then (contract v1.13) ICD-10-CM and MONDO when their pinned
releases are downloaded; without them it says so and the store serves ICD-11
only. The live store is never touched. See backend/demo/README.md.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..importers.legacy_json import DEFAULT_SEED_DIR, ContractViolation, ImportRefused
from ..ontologies.sources import SourceInvalid, sources_dir
from ..publishing.uploads import AdminError
from .builder import DEFAULT_DEMO_DB, PACK_DIR, DemoBuildError, build


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.demo", description="Build the dashboard demo store from the seed and the demo pack.")
    commands = parser.add_subparsers(dest="command", required=True)
    build_parser = commands.add_parser("build", help="rebuild the demo store and publish the demo pack into it")
    build_parser.add_argument("--db", type=Path, default=DEFAULT_DEMO_DB, help="demo store to (re)build (default backend/data/dashboard-demo.sqlite)")
    build_parser.add_argument("--uploads-dir", type=Path, default=None, help="folder for its upload files (default <store name>-uploads next to it)")
    build_parser.add_argument("--pack", type=Path, default=PACK_DIR, help="demo pack directory (default backend/demo)")
    build_parser.add_argument("--seed", type=Path, default=DEFAULT_SEED_DIR, help="seed directory (default backend/seed)")
    build_parser.add_argument("--no-import", action="store_true", help="use the store as it is (it must be a fresh seed import)")
    build_parser.add_argument("--quiet", action="store_true", help="only print the result")
    build_parser.add_argument(
        "--ontology-sources",
        type=Path,
        default=None,
        help="downloaded ontology releases (default $BMC_ONTOLOGY_SOURCES, else backend/data/ontology-sources)",
    )
    build_parser.add_argument("--no-ontologies", action="store_true", help="do not import ICD-10-CM and MONDO (contract v1.13)")
    args = parser.parse_args(argv)

    log = (lambda message: None) if args.quiet else (lambda message: print(f"  {message}", flush=True))
    try:
        report = build(
            args.db,
            pack_dir=args.pack,
            seed_dir=args.seed,
            uploads_dir=args.uploads_dir,
            import_seed=not args.no_import,
            log=log,
            ontology_sources=None if args.no_ontologies else sources_dir(args.ontology_sources),
        )
    except (DemoBuildError, ContractViolation, ImportRefused, SourceInvalid) as error:
        print(f"demo build failed: {error}", file=sys.stderr)
        return 1
    except AdminError as error:
        print(f"demo build failed: {error.code}: {error}", file=sys.stderr)
        return 1
    print(report.describe())
    return 0


if __name__ == "__main__":
    sys.exit(main())
