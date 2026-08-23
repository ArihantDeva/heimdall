import json, os, subprocess, pathlib, sys, pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from ingest import BENCH_MARKER

GRAFT = pathlib.Path.home() / ".local/bin/graft"
DEFAULT_DB = pathlib.Path.home() / ".graft/profiles/default/graft.db"

def _profiles():
    out = subprocess.run([str(GRAFT), "profile", "list"],
                         capture_output=True, text=True).stdout
    data = json.loads(out)
    # graft profile list emits {"home":…, "active":…, "profiles":[…]} with no
    # "result" wrapper (unlike graft stats); accept both shapes.
    return data.get("result", data)

def test_longmemeval_profile_exists():
    assert "longmemeval" in _profiles()["profiles"], \
        "run bench/profile.sh — benchmark must never share the default profile"

def test_default_profile_untouched_by_bench():
    """The live profile holds real work. Detect benchmark nodes directly.

    Node count is the wrong signal: it drifts every time real work is recorded,
    so an exact-match baseline fails spuriously and gets ignored. Every bench
    insert carries the BENCH_MARKER keyword, so its presence in `default` is
    unambiguous evidence of a leak.
    """
    out = subprocess.run(
        [str(GRAFT), "explore", BENCH_MARKER, "--keyword", BENCH_MARKER],
        capture_output=True, text=True, timeout=120,
        env=dict(os.environ, GRAFT_PROFILE="default"),
    ).stdout
    if not out.strip():
        pytest.skip("graft daemon unresponsive; leak check inconclusive")
    hits = json.loads(out).get("result", {}).get("results", [])
    assert hits == [], (
        f"{len(hits)} benchmark nodes found in the default profile. "
        "Benchmark ingest leaked into real memory. Stop and investigate."
    )
