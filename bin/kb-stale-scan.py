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
import json
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
        except Exception as e:
            # Do NOT write a cache here. An empty cache file means "searched,
            # found nothing", and kb-rehome.sh treats that as NOTFOUND, which
            # the caller turns into `graft delete`. A timeout or an OS error
            # says nothing about the file's existence. Return nothing and let
            # the caller fall back to its own (fail-closed) search. Measured
            # 2026-10-23: this `pass` was on the same delete path as the
            # unchecked-find bug fixed in kb-rehome.sh.
            print(f"WARN: search for {base!r} failed ({type(e).__name__}: {e}); "
                  f"not caching a result", file=sys.stderr)
            return cache if os.path.exists(cache) else ""
    with open(cache, "w") as f:
        f.write("\n".join(hits))
    return cache


def count_only():
    """Read-only stale census for `heimdall score` — no find, no rehome, no delete."""
    if not os.path.exists(DB):
        print('{"nodes": 0, "stale": 0}')
        return 0
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = db.execute("SELECT hex(id), title, body FROM nodes").fetchall()
    db.close()
    nodes = stale = 0
    for _id_hex, title, body in rows:
        paths = extract_paths(body or title)
        # Same rule as the full sweep: a node with any live anchor is still
        # reachable; only all-anchors-dead counts as stale.
        if paths and not any(os.path.exists(p) for p in paths):
            stale += 1
        nodes += 1
    print(json.dumps({"nodes": nodes, "stale": stale}))
    return 0


# One scan may not remove more than this fraction of the graph. See the
# circuit breaker in main().
MASS_DELETE_FRACTION = 0.5


def _definitely_absent(path: str) -> bool:
    """True only when the path is PROVABLY gone.

    os.path.exists() returns False for a permission error, an I/O error or a
    dead symlink as well as for a genuinely missing file. On 2026-10-23 that
    mattered: a node whose file merely sat under an unreadable directory was
    counted dead, and a dead node is deleted with `graft delete` — irreversible,
    with the file still on disk.

    Reproduced: chmod 000 on a parent dir makes os.path.exists() false while the
    file exists. Same class as the unchecked find, the unreadable vector
    dimension and the failed stat() found the same day: a destructive branch
    gated on a signal that cannot tell "absent" from "could not look".

    So: stat() first. ENOENT is absence. Anything else — EACCES, EIO, ELOOP,
    ENOTDIR on a broken parent — is UNKNOWN, and unknown must never mean delete.
    """
    try:
        os.stat(path)
        return False          # it is there
    except FileNotFoundError:
        return True           # provably absent
    except OSError:
        return False          # could not determine: treat as ALIVE (keep node)
    except ValueError:
        return False          # malformed path: do not delete on a parse failure


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--count-only" in argv:
        return count_only()
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    rows = db.execute("SELECT hex(id), title, body FROM nodes").fetchall()
    db.close()
    total = len(rows)
    stale = removed = rebuilt = ambiguous = unresolved = kept_mass = 0
    tmpdir = tempfile.mkdtemp(prefix="kbrh-")

    for i, (id_hex, title, body) in enumerate(rows):
        paths = extract_paths(body or title)
        dead = [p for p in paths if _definitely_absent(p)]
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

        if out.startswith("SEARCHFAILED"):
            # The search itself failed (permission denied, I/O error, timeout).
            # That says NOTHING about whether the file exists, so do not touch
            # the node: deleting on a transient read error is irreversible
            # (graft delete) and would silently shrink the graph. Fail closed,
            # matching the contract cli-main.mjs states for sensor loss.
            unresolved += 1
            print(f"UNRESOLVED  {path} [{out}]  {title[:60]}")
            continue
        if out.startswith("REBUILT "):
            rebuilt += 1
            newpath = out.split(" ", 1)[1]
            with open(RHLOG, "a") as f:
                f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} | {id_hex} | {path} -> {newpath}\n")
            print(f"REBUILT  {path} -> {newpath}\n         {title[:70]}")
        else:
            # CIRCUIT BREAKER (2026-10-23). `graft delete` is irreversible and
            # this loop had no bound of any kind: every node whose paths looked
            # dead was deleted, silently, in one pass. A wrong DB path, a
            # half-mounted volume, or an unreadable tree makes every path look
            # dead at once, and the whole graph goes. Same rule the SQL pruner
            # now enforces: refuse a mass deletion, keep the nodes, say so.
            planned = removed + 1
            if total and planned / total > MASS_DELETE_FRACTION \
                    and os.environ.get("HEIMDALL_PRUNE_ALLOW_MASS") != "1":
                kept_mass += len(rows) - i
                print(f"\nREFUSING to delete {planned}/{total} nodes "
                      f"(> {MASS_DELETE_FRACTION:.0%} of the graph) in one scan. "
                      f"That ratio usually means the tree was not visible "
                      f"(wrong HOME, unmounted volume, permissions), not that the "
                      f"files are gone. NO further nodes were deleted and none of "
                      f"the remaining {len(rows) - i} were examined. "
                      f"Set HEIMDALL_PRUNE_ALLOW_MASS=1 to force.", file=sys.stderr)
                break
            removed += 1
            if out == "AMBIGUOUS":
                ambiguous += 1
            stamp = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            with open(LOG, "a") as f:
                f.write(f"{stamp} | {id_hex} | {path} | {out}\n  title: {title}\n  body: {(body or '').replace(chr(10), ' ⏎ ')}\n")
            subprocess.run(["graft", "delete", id_hex], capture_output=True, text=True, timeout=15)
            print(f"REMOVED  {path} [{out}]  {title[:60]}")

    print(f"\n== scan done: {total} nodes | {stale} stale | {rebuilt} rehomed | {removed} removed | {ambiguous} ambiguous | {unresolved} unresolved (search failed, kept)"
          + (f" | {kept_mass} KEPT (mass-delete refused)" if kept_mass else ""))


if __name__ == "__main__":
    sys.exit(main())
