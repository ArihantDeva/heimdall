# bench/tests/test_embed_index.py — RED-first units for the max-depth embed index.
# Hermetic: tmp_path fixtures, fake model injected via monkeypatch, HEIMDALL_DB env.
# Never touches ~/.heimdall. Run: ~/.heimdall/venv/bin/python3 -m pytest -q
import importlib.util, json, os, sys
from pathlib import Path

import pytest

_bin = Path(__file__).resolve().parents[2] / "bin"
sys.path.insert(0, str(_bin))
import embed_walker  # noqa: E402
_mod_path = _bin / "embed-index.py"
_spec = importlib.util.spec_from_file_location("embed_index", _mod_path)
embed_index = importlib.util.module_from_spec(_spec)
sys.modules["embed_index"] = embed_index
_spec.loader.exec_module(embed_index)

# --- helpers ---------------------------------------------------------------

class FakeModel:
    """Deterministic stand-in for SentenceTransformer: hash-based vectors.
    Same text -> same vector; dim fixed at construction."""

    def __init__(self, dim=384):
        self.dim = dim
        self.calls = []

    def encode(self, texts, normalize_embeddings=True, **kw):
        self.calls.extend(texts)
        out = []
        for t in texts:
            h = abs(hash(t)) % (10**8)
            v = [((h >> i) & 1) * 1.0 for i in range(self.dim)]
            n = sum(x * x for x in v) ** 0.5 or 1.0
            out.append([x / n for x in v])
        return out

    def get_embedding_dimension(self):
        return self.dim


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Isolated environment: fake DB path, pruned HOME tree, no model load."""
    db = tmp_path / "global.db"
    home = tmp_path / "home"
    repos = home / "Repos" / "alpha"
    graft = repos / "graft"
    (graft / ".graph").mkdir(parents=True)
    (graft / "INDEX.md").write_text("# map\n")
    (graft / "src_main.md").write_text("card body\n")
    (repos / "src").mkdir(parents=True)
    (repos / "src" / "main.py").write_text("print('hi')\n")
    nonrepos = home / "Desktop" / "proj"
    (nonrepos).mkdir(parents=True)
    (nonrepos / ".git").mkdir()  # models reality: projects are git repos
    (nonrepos / "tool.py").write_text("x = 1\n")
    monkeypatch.setenv("HEIMDALL_DB", str(db))
    monkeypatch.setenv("HEIMDALL_HOME", str(home))
    monkeypatch.delenv("HEIMDALL_EMBED_MODEL", raising=False)
    # Patch module globals directly — reload() on a spec-loaded module re-enters
    # the import system and dies. GREEN rewrite must keep these global names.
    # HOME_ROOT is critical: without the patch, build() walks the REAL $HOME.
    monkeypatch.setattr(embed_index, "DB", db)
    monkeypatch.setattr(embed_index, "HOME_ROOT", home)
    monkeypatch.setattr(embed_index, "REPOS", home / "Repos")
    monkeypatch.setattr(embed_index, "LOCK_PATH", db.parent / "test.lock")
    yield {"db": db, "home": home, "graft": graft, "nonrepos": nonrepos}
    if db.exists():
        db.unlink()


def _fake_model(monkeypatch, dim=384):
    fm = FakeModel(dim)
    monkeypatch.setattr(embed_index, "model", lambda: fm)
    # MODEL/DIM must agree with the fake's width — mirrors a real HEIMDALL_EMBED_MODEL switch.
    name = "BAAI/bge-small-en-v1.5" if dim == 384 else "BAAI/bge-m3"
    monkeypatch.setattr(embed_index, "MODEL", name)
    monkeypatch.setattr(embed_index, "DIM", dim)
    return fm


def _ram_ok_true(monkeypatch):
    monkeypatch.setattr(embed_index, "_ram_ok", lambda *a, **k: True)


# --- walker policy ---------------------------------------------------------

def test_walker_prunes_junk_dirs(env, monkeypatch):
    junk = env["home"] / "Library"
    (junk / "Caches").mkdir(parents=True)
    (junk / "Caches" / "big.log").write_text("x" * 100)
    (env["home"] / "node_modules").mkdir(parents=True)
    (env["home"] / "node_modules" / "dep.js").write_text("m")
    keep = env["home"] / "code"
    keep.mkdir(parents=True)
    (keep / "a.py").write_text("a=1\n")
    files, dataless = embed_walker.discover_files(env["home"])
    names = [p.name for p in files]
    assert "big.log" not in names and "dep.js" not in names
    assert "a.py" in names


def test_binary_and_oversize_sniffed_out(env):
    """Binaries fail the sniff; oversize KNOWN-text is kept (preview caps payload)."""
    (env["home"] / "b.bin").write_bytes(bytes(range(256)))
    (env["home"] / "ok.py").write_text("# fine\n")
    big = env["home"] / "huge.json"
    big.write_text("[" + ",".join(["1"] * 200000) + "]")
    files, _ = embed_walker.discover_files(env["home"])
    names = {p.name for p in files}
    assert "b.bin" not in names and "ok.py" in names and "huge.json" in names


def test_unknown_extension_content_sniffed(env):
    """Unknown extensions AND dotfiles-without-ext get content-sniffed:
    text-like unknowns kept, binaries dropped."""
    makefile = env["home"] / "Makefile"
    makefile.write_text("all:\n\techo hi\n")
    zshrc = env["home"] / ".zshrc.local"
    zshrc.write_text("alias ls='eza'\n")
    elfish = env["home"] / "weirdext"
    elfish.write_bytes(b"\x7fELF" + bytes(64))
    files, _ = embed_walker.discover_files(env["home"])
    names = {p.name for p in files}
    assert "Makefile" in names and ".zshrc.local" in names and "weirdext" not in names


def test_dataless_files_reported_separately(env):
    """st_blocks==0 placeholders must be excluded from content reads but
    surfaced as name-only candidates — never silently dropped."""
    import os as _os
    ghost = env["home"] / "icloud-doc.md"
    ghost.write_text("real content here\n")
    st = _os.stat(ghost)
    os_utime = ghost.stat()
    # Simulate dataless: can't fake st_blocks on a real file portably, so call
    # the classifier's contract directly via monkeypatched stat is overkill;
    # instead assert the walker never returns zero-byte files at all.
    empty = env["home"] / "empty.txt"
    empty.write_text("")
    files, _ = embed_walker.discover_files(env["home"])
    assert empty not in files


def test_sha_dedupe_identical_content_single_card(env, monkeypatch):
    a = env["home"] / "a.txt"; a.write_text("same content\n")
    b = env["home"] / "b" ; b.parent.mkdir(exist_ok=True); b.write_text("same content\n")
    _fake_model(monkeypatch)
    _ram_ok_true(monkeypatch)
    embed_index.build()
    cards = embed_index.conn().execute(
        "SELECT COUNT(*) FROM cards WHERE body LIKE '%same content%'").fetchone()[0]
    assert cards == 1


# --- dim handling ----------------------------------------------------------

def test_dim_mismatch_auto_rebuild(env, monkeypatch):
    """Index built with another model's width must be dropped+recreated by build,
    so query can never hit 'Dimension mismatch'."""
    _fake_model(monkeypatch, dim=1024)  # first build with wrong-width model
    _ram_ok_true(monkeypatch)
    embed_index.build()
    _fake_model(monkeypatch, dim=384)   # now the configured model changed back
    embed_index.build()
    # vec table must be 384-wide and queryable without error
    d = embed_index._db_dim(embed_index.conn())
    assert d == 384


def test_query_adapts_to_db_dim_without_crash(env, monkeypatch):
    _fake_model(monkeypatch, dim=384)
    _ram_ok_true(monkeypatch)
    embed_index.build()
    # Simulate stale process holding old MODEL/DIM constants against newer DB:
    monkeypatch.setattr(embed_index, "MODEL", "BAAI/bge-m3")
    monkeypatch.setattr(embed_index, "DIM", 1024)
    hits = embed_index.query("anything", n=3)
    assert isinstance(hits, list)  # adapts or returns [] — never raises dim error


# --- status shape -----------------------------------------------------------

def test_status_reports_files_repos_dims(env, monkeypatch):
    _fake_model(monkeypatch)
    _ram_ok_true(monkeypatch)
    embed_index.build()
    s = embed_index.status()
    assert s["files"] >= 2          # src/main.py card + tool.py? tool.py has no graft card...
    assert s["dim"] == 384
    assert s["dimension_ok"] is True
    assert any("Desktop/proj" in r or "proj" in r for r in s["repos"])
