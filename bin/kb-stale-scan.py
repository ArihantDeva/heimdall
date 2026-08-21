#!/usr/bin/env python3
"""kb-stale-scan.py — full-graph stale sweep, with per-basename find caching.

For every node whose home-anchored path is gone: try a deterministic rehome
(kb-rehome.sh — bounded basename search; exactly one FILE hit → rebuild the
node with the corrected path). If the file is truly gone or the move is
ambiguous, log the full node to stale-removals.log and delete it so dead
anchors stop ranking. The expensive Desktop find runs ONCE per unique
basename (cached), not once per stale node — Desktop reorgs leave many nodes
pointing at the same few dead paths. Reuses extract_paths from
kb_search_verify.py so scan and search agree on what counts as stale.
"""
import os, sqlite3, subprocess, sys, tempfile, time

# kb_search_verify lives beside this script. It used to be imported from
# ~/knowledge-base, which only worked on the author's machine and silently
# imported a DIFFERENT copy when one happened to be there.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kb_search_verify import extract_paths  # noqa: E402 — same path logic as search

KB = os.path.expanduser("~/knowledge-base")
DB = os.path.expanduser("~/.graft/profiles/default/graft.db")
LOG = os.path.join(KB, "stale-removals.log")
RHLOG = os.path.join(KB, "stale-rehomes.log")
ROOTS = ["Desktop", "projects", "Music", ".pi/agent", ".local/bin", "Library/LaunchAgents"]
EXCL = [
    "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*",
    "-not", "-path", "*/linkedin_session/*", "-not", "-path", "*/.build/*",
    "-not", "-path", "*/.venv/*", "-not", "-path", "*/venv/*",
    "-not", "-path", "*/Pods/*", "-not", "-path", "*/DerivedData/*",
]


def find_basename(base, tmpdir):
    """Run the bounded find once per basename; cache the result file."""
    cache = os.path.join(tmpdir, base.replace("/", "_"))
    if os.path.exists(cache):
        return cache
    hits = []
    for root in ROOTS:
        r = os.path.expanduser(f"~/{root}")
        if not os.path.isdir(r):
            continue
        try:
            # find -name treats the pattern as a glob — escape [ ] * ? so a literal
            # filename like "report[1].md" matches only itself (mirrors kb-rehome.sh)
            import fnmatch
            safe = base.replace("[", "[[]").replace("*", "[*]").replace("?", "[?]")
            out = subprocess.run(
                ["find", r, "-maxdepth", "8", "-name", safe, *EXCL],
                capture_output=True, text=True, timeout=120,
            ).stdout
            hits.extend(h for h in out.splitlines() if h)
        except Exception:
            pass
    with open(cache, "w") as f:
        f.write("\n".join(hits))
    return cache


def main():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = db.execute("SELECT hex(id), title, body FROM nodes").fetchall()
    db.close()
    total = len(rows)
    stale = removed = rebuilt = ambiguous = 0
    tmpdir = tempfile.mkdtemp(prefix="kbrh-")

    for id_hex, title, body in rows:
        paths = extract_paths(body or title)
        dead = [p for p in paths if not os.path.exists(p)]
        alive = [p for p in paths if os.path.exists(p)]
        # only self-heal when ALL anchors are dead — a node with one live path
        # is still reachable; deleting it would lose the live reference
        if not dead or alive:
            continue
        stale += 1
        path = dead[0]
        cache = find_basename(os.path.basename(path), tmpdir)
        with tempfile.NamedTemporaryFile("w", suffix=".body", delete=False) as f:
            f.write(body or "")
            bodyf = f.name
        try:
            r = subprocess.run(
                [os.path.join(KB, "kb-rehome.sh"), id_hex, path, title or "", bodyf, cache],
                capture_output=True, text=True, timeout=30,
            )
            out = r.stdout.strip()
        except Exception:
            out = "NOTFOUND"
        finally:
            os.unlink(bodyf)

        if out.startswith("REBUILT "):
            rebuilt += 1
            newpath = out.split(" ", 1)[1]
            with open(RHLOG, "a") as f:
                f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} | {id_hex} | {path} -> {newpath}\n")
            print(f"REBUILT  {path} -> {newpath}\n         {title[:70]}")
        else:
            removed += 1
            if out == "AMBIGUOUS":
                ambiguous += 1
            stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            with open(LOG, "a") as f:
                f.write(f"{stamp} | {id_hex} | {path} | {out}\n  title: {title}\n  body: {(body or '').replace(chr(10), ' ⏎ ')}\n")
            subprocess.run(["graft", "delete", id_hex], capture_output=True, text=True, timeout=15)
            print(f"REMOVED  {path} [{out}]  {title[:60]}")

    print(f"\n== scan done: {total} nodes | {stale} stale | {rebuilt} rehomed | {removed} removed ({ambiguous} ambiguous)")


if __name__ == "__main__":
    main()
