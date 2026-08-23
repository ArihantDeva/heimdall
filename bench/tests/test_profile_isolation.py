import json, subprocess, pathlib, pytest

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
    """The live profile holds real work. Guard its node count."""
    baseline = pathlib.Path(__file__).parent / "default_node_count.txt"
    out = subprocess.run([str(GRAFT), "stats"], capture_output=True, text=True).stdout
    n = json.loads(out)["result"]["n_nodes"]
    if not baseline.exists():
        baseline.write_text(str(n))
        pytest.skip(f"recorded default-profile baseline: {n} nodes")
    assert n == int(baseline.read_text()), (
        f"default profile node count changed {baseline.read_text()} -> {n}. "
        "Benchmark ingest leaked into real memory. Stop and investigate."
    )
