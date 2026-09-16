#!/usr/bin/env python3
"""Render heimdall-infrastructure.png — how Heimdall works: data flow from
your edits through the reconciler into the graph stores, out through
kb_search with trust verdicts, plus the dependency stack. Terminal style:
black bg, cyan monospace, box-drawing. Deterministic PIL."""
from PIL import Image, ImageDraw, ImageFont

W, H = 1560, 1264
BLACK = (0, 0, 0)
CYAN = (127, 214, 247)
CYAN_DIM = (86, 156, 184)
WHITE = (232, 232, 232)
RED = (255, 107, 107)
GREEN = (126, 231, 135)
GREY = (120, 120, 120)
DARKGREY = (60, 60, 60)

F = lambda s: ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", s)
F_TITLE = F(40)
F_SUB = F(20)
F_HEAD = F(24)
F_BOX = F(19)
F_SM = F(16)
F_MICRO = F(14)

img = Image.new("RGB", (W, H), BLACK)
d = ImageDraw.Draw(img)


def text(xy, s, font=F_BOX, fill=WHITE, anchor="la"):
    d.text(xy, s, font=font, fill=fill, anchor=anchor)


def tw(s, font=F_BOX):
    return d.textlength(s, font=font)


def node(x0, y0, x1, y1, title, lines, color=CYAN, fill=(12, 16, 20)):
    d.rectangle([x0, y0, x1, y1], fill=fill, outline=color, width=2)
    cx = (x0 + x1) // 2
    text((cx, y0 + 12), title, F_BOX, color, "ma")
    yy = y0 + 40
    for ln in lines:
        text((cx, yy), ln, F_SM, GREY if color != GREEN else GREY, "ma")
        yy += 20
    return (x0, y0, x1, y1)


def arrow_v(x, y0, y1, color=CYAN_DIM, label=None):
    d.line([(x, y0), (x, y1)], fill=color, width=2)
    d.line([(x, y1), (x - 5, y1 - 9)], fill=color, width=2)
    d.line([(x, y1), (x + 5, y1 - 9)], fill=color, width=2)
    if label:
        text((x + 10, (y0 + y1) // 2 - 9), label, F_MICRO, GREY)


def arrow_h(x0, x1, y, color=CYAN_DIM, label=None):
    d.line([(x0, y), (x1, y)], fill=color, width=2)
    d.line([(x1, y), (x1 - 9, y - 5)], fill=color, width=2)
    d.line([(x1, y), (x1 - 9, y + 5)], fill=color, width=2)
    if label:
        text(((x0 + x1) // 2, y - 22), label, F_MICRO, GREY, "ma")


# ================= TITLE =================
text((W // 2, 50), "HOW HEIMDALL WORKS", F_TITLE, CYAN, "mm")
text((W // 2, 96), "one local daemon · zero LLM calls at index time · every hit verified against disk", F_SUB, GREY, "mm")

# ================= SECTION 1: INGEST =================
Y = 140
text((80, Y), "── INGEST PATH ", F_HEAD, CYAN)
w = tw("── INGEST PATH ", F_HEAD)
d.line([(80 + w + 12, Y + 14), (W - 80, Y + 14)], fill=DARKGREY, width=2)
Y += 44

# Row 1: sources
sy = Y
sw = 300
sh = 96
srcs = [
    ("YOUR REPOS", ["~/Repos/* working trees", "code · docs · notes"]),
    ("AGENT SESSIONS", ["prompt logs · edit logs", "kb_insert facts"]),
    ("EMAIL (opt-in)", ["cli-email · read-only", "CPU-only ingest"]),
]
sx = 80
src_boxes = []
for t, ls in srcs:
    src_boxes.append(node(sx, sy, sx + sw, sy + sh, t, ls, CYAN_DIM))
    sx += sw + 40

# Row 2: watcher + journal
Y2 = sy + sh + 56
watch = node(80, Y2, 80 + 460, Y2 + 88, "kb-autosync (watcher)", ["file events → hints", "hint queue: ~/.heimdall/hints"], CYAN_DIM)
journal = node(620, Y2, 620 + 460, Y2 + 88, "JOURNAL (append-only)", ["single source of truth", "idempotent, level-triggered"], GREEN)
for b in src_boxes:
    arrow_v((b[0] + b[2]) // 2, b[3], Y2 - 4)
arrow_h(watch[2], journal[0], Y2 + 44, label="hints")

# Row 3: reconciler
Y3 = Y2 + 88 + 56
rec = node(240, Y3, 240 + 620, Y3 + 88, "RECONCILER — the single writer", ["drains journal → projects into graphs", "moved files re-anchor · deletes retract exactly"], CYAN)
arrow_v(journal[0] + 230, journal[3], Y3 - 4)

# Row 4: stores
Y4 = Y3 + 88 + 56
st1 = node(140, Y4, 140 + 380, Y4 + 96, "graft graph (per-repo)", ["@nanonets/graft fork", "tree-sitter AST + graph edges"], CYAN_DIM)
st2 = node(590, Y4, 590 + 380, Y4 + 96, "global.db (semantic)", ["sqlite + sqlite-vec", "local embeddings — bge-m3"], CYAN_DIM)
st3 = node(1040, Y4, 1040 + 380, Y4 + 96, "~/.heimdall/memories/", ["durable kb_insert JSON", "atomic · 0600 · instantly searchable"], CYAN_DIM)
arrow_v(560 - 100, rec[3], Y4 - 4)
# spread from reconciler
d.line([(560, rec[3]), (560, Y4 - 28)], fill=CYAN_DIM, width=2)
for x in (330, 780, 1230):
    d.line([(560, Y4 - 28), (x, Y4 - 28)], fill=CYAN_DIM, width=2)
    arrow_v(x, Y4 - 28, Y4 - 4)

# ================= SECTION 2: RETRIEVAL =================
YR = Y4 + 96 + 60
text((80, YR), "── RETRIEVAL PATH ", F_HEAD, CYAN)
w = tw("── RETRIEVAL PATH ", F_HEAD)
d.line([(80 + w + 12, YR + 14), (W - 80, YR + 14)], fill=DARKGREY, width=2)
YR += 44

q = node(80, YR, 80 + 340, YR + 88, "agent query", ["kb_search / MCP / CLI", "heimdall search --hybrid"], CYAN)
fus = node(480, YR, 480 + 400, YR + 88, "RRF FUSION", ["Σ 1/(60+rank) over lexical + vector", "adaptive recall ladder 200 → 2000"], CYAN)
ver = node(940, YR, 940 + 480, YR + 88, "VERIFY LAYER", ["path exists? content answers?", "as_of freshness: fresh / possibly_stale"], GREEN)
arrow_h(q[2], fus[0], YR + 44)
arrow_h(fus[2], ver[0], YR + 44)

# verdict row
YV = YR + 88 + 30
verds = [("STRONG", GREEN, "act on it"), ("WEAK", CYAN_DIM, "verify first"), ("REBUILT", CYAN, "re-anchored"), ("STALE", RED, "pruned")]
vx = 940
for name, col, desc in verds:
    d.rectangle([vx, YV, vx + 112, YV + 30], outline=col, width=2)
    text((vx + 56, YV + 15), name, F_MICRO, col, "mm")
    text((vx, YV + 36), desc, F_MICRO, GREY, "ma")
    vx += 122
arrow_v(ver[0] + 240, ver[3], YV - 4)

# guard note
text((80, YR + 20), "guard: rg for exact lookup,", F_SM, GREY)
text((80, YR + 44), "kb_search for discovery", F_SM, GREY)

# ================= SECTION 3: DEPENDENCIES =================
YD = YV + 90
text((80, YD), "── DEPENDENCY STACK (all local, all CPU-first) ", F_HEAD, CYAN)
w = tw("── DEPENDENCY STACK (all local, all CPU-first) ", F_HEAD)
d.line([(80 + w + 12, YD + 14), (W - 80, YD + 14)], fill=DARKGREY, width=2)
YD += 44

deps = [
    ("graftd daemon", "C++ · static llama.cpp b10760", "Metal / CUDA / CPU", CYAN),
    ("llama.cpp", "vendored · FetchContent", "self-contained binary", CYAN_DIM),
    ("bge-m3 embeddings", "local model · 1024-dim", "~587MB · ~/.graft/models", CYAN_DIM),
    ("sqlite + sqlite-vec", "graph store + vector index", "zero cloud", CYAN_DIM),
    ("tree-sitter", "AST parsing at ingest", "no LLM extraction", CYAN_DIM),
    ("node >= 22.5", "harness · hooks · MCP server", "npm i -g @arihantdeva/heimdall", CYAN_DIM),
    ("cmake / sqlite3 / libyaml", "build-time only", "apt / brew / dnf", GREY),
]
dx = 80
dy = YD
colw = (W - 160 - 2 * 24) // 3
rowh = 74
for i, (t, l1, l2, col) in enumerate(deps):
    r, c = divmod(i, 3)
    x = dx + c * (colw + 24)
    y = dy + r * (rowh + 18)
    d.rectangle([x, y, x + colw, y + rowh], outline=col, width=2)
    text((x + 12, y + 10), t, F_BOX, col)
    text((x + 12, y + 36), l1, F_SM, GREY)
    text((x + 12, y + 54), l2, F_SM, GREY)

# harness row
yh = dy + 3 * (rowh + 18) + 8
text((80, yh), "harness adapters: ", F_BOX, CYAN)
adapters = "pi · claude code · codex · cursor · windsurf   (heimdall init --harness <name>)"
text((80 + tw("harness adapters: ", F_BOX) + 12, yh), adapters, F_BOX, WHITE)

# footer
d.line([(80, H - 112), (W - 80, H - 112)], fill=DARKGREY, width=2)
text((80, H - 88), "github.com/ArihantDeva/heimdall", F_HEAD, CYAN)
text((80, H - 52), "MIT · v0.10.0 · 344/344 tests green", F_SM, GREY)
text((W - 80, H - 88), "zero tokens", F_HEAD, GREEN, "ra")
text((W - 80, H - 52), "at index time, forever", F_SM, GREY, "ra")

img.save("/Users/arihantdeva/Repos/heimdall/docs/heimdall-infrastructure.png")
print("saved", W, H)
