"""Start a durable full-catalog reanalysis and stream compact progress."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.main import resource_refresh  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=int, default=900, help="Maximum seconds to wait.")
    parser.add_argument("--due", action="store_true", help="Resume only sources that are missing or due.")
    args = parser.parse_args()

    run = resource_refresh.start_full_refresh(force=not args.due)
    run_id = str(run["run_id"])
    print(json.dumps(run, ensure_ascii=False, sort_keys=True), flush=True)
    deadline = time.monotonic() + max(1, args.timeout)
    last_progress = (-1, "")
    while time.monotonic() < deadline:
        current = resource_refresh.job_status(run_id)
        marker = (int(current["processed"]), str(current["status"]))
        if marker != last_progress:
            print(json.dumps(current, ensure_ascii=False, sort_keys=True), flush=True)
            last_progress = marker
        if current["status"] not in {"queued", "running"}:
            return 0 if current["status"] == "completed" else 2
        time.sleep(0.5)
    print(json.dumps({"run_id": run_id, "status": "client_timeout"}, sort_keys=True), flush=True)
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
