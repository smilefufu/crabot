"""crabot-memory v0 -> v1 (no-op shim).

Pre-versioning memory data (before SCHEMA_VERSION existed) is already
v1-shaped: LanceDB ``long_term_memory`` table + ``metadata.db``. This
shim exists only so the upgrade framework can chain v0 -> v1 -> v2.

Usage: uv run python crabot-memory/upgrade/from_v0_to_v1.py --data-dir=<path>
"""
import argparse


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.parse_args()
    print("[from_v0_to_v1] no-op: treating legacy data as v1 baseline.")


if __name__ == "__main__":
    main()
