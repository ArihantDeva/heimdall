#!/usr/bin/env bash
# bench/profile.sh — create/activate the isolated benchmark profile.
set -euo pipefail
GRAFT="${GRAFT:-$HOME/.local/bin/graft}"
"$GRAFT" profile add longmemeval || echo "profile already exists"
"$GRAFT" profile list
echo
echo "NOTE: the benchmark runner passes the profile explicitly."
echo "It never calls 'profile set', so your interactive graft stays on 'default'."
