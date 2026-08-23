#!/usr/bin/env bash
# bench/fetch_data.sh — download LongMemEval into bench/data (gitignored).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
DATA="$HERE/data"
mkdir -p "$DATA"
PY="${HEIMDALL_PYTHON:-$HOME/.heimdall/venv/bin/python3}"

"$PY" -m pip install --quiet --upgrade huggingface_hub

DATA="$DATA" "$PY" - <<'EOF'
import os, pathlib
from huggingface_hub import snapshot_download
dest = pathlib.Path(os.environ["DATA"])
p = snapshot_download(
    repo_id="xiaowu0162/longmemeval",
    repo_type="dataset",
    local_dir=str(dest),
    allow_patterns=["*oracle*", "*_s*"],
)
# HF repo stores the datasets as EXTENSIONLESS files (longmemeval_s,
# longmemeval_oracle) — verified by listing the repo. The bench contract
# requires .json names, so rename them in place.
for name in ("longmemeval_s", "longmemeval_oracle"):
    src = dest / name
    dst = pathlib.Path(str(src) + ".json")
    if src.exists() and not dst.exists():
        src.rename(dst)
    print("renamed", src.name, "->", dst.name)
for f in sorted(dest.glob("*.json")):
    print(" ", f.name, f.stat().st_size)
EOF

echo "--- checksums ---"
shasum -a 256 "$DATA"/*.json | tee "$HERE/data.sha256"
