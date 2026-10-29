#!/usr/bin/env bash
# Compatibility entry; lifecycle and ownership are shared with Windows.
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/scripts/dev.mjs" "$@"
