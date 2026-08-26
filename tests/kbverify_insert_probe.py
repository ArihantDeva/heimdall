#!/usr/bin/env python3
"""kbverify_insert_probe.py — insert→searchable roundtrip on a SCRATCH index.
Usage: HEIMDALL_SCRATCH=<dir> python3 kbverify_insert_probe.py <embed-index.py> <out>
Creates a fact card inside the scratch HOME, indexes it via insert_card,
queries for its unique marker, writes INSERT-SEARCHABLE or INSERT-BROKEN."""
import os
import pathlib
import sys

scratch = pathlib.Path(os.environ["HEIMDALL_SCRATCH"])
embed_script, out_path = sys.argv[1], sys.argv[2]

os.environ["HEIMDALL_DB"] = str(scratch / "db.sqlite")
os.environ["HEIMDALL_HOME"] = str(scratch)
os.environ["HEIMDALL_LOCK"] = str(scratch / "lock")

import importlib.util  # noqa: E402

sys.path.insert(0, str(pathlib.Path(embed_script).parent))  # embed_walker lives beside embed-index.py
spec = importlib.util.spec_from_file_location("embed_index_probe", embed_script)
m = importlib.util.module_from_spec(spec)
sys.modules["embed_index_probe"] = m
spec.loader.exec_module(m)

card = scratch / "probe-fact.md"
card.write_text("# verify probe\n\nzzverify zzmarker unique content\n", encoding="utf-8")

# RAM-gate off for the probe: the gate is production behavior tested elsewhere.
m._ram_ok = lambda *a, **k: True
rc = m.insert_card(str(card))
hits = m.query("zzverify zzmarker unique", n=2)

verdict = "INSERT-BROKEN"
if rc == 0 and hits and any("zzverify" in h.get("path", "") or h.get("score", 0) > 0.5 for h in hits):
    verdict = "INSERT-SEARCHABLE"
pathlib.Path(out_path).write_text(verdict + "\n" + repr(hits), encoding="utf-8")
