#!/usr/bin/env python3
"""Render heimdall-explainer.png — one clean diagram: architecture
(single-writer reconciler, kb_search, verdicts) + before/after terminal
panels with fake dirs/names and a bash-command count. Deterministic PIL."""
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 1000
BG = (13, 17, 23)
PANEL = (22, 27, 34)
FG = (230, 237, 243)
ACCENT = (88, 166, 255)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
YELLOW = (210, 153, 34)
DIM = (139, 148, 158)
LINE = (48, 54, 61)

FONT = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 17)
FONT_SM = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 14)
FONT_XS = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 12)
FONT_TITLE = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 26)
FONT_H = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 19)

img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)


def text(xy, s, font=FONT, fill=FG, anchor="la"):
    d.text(xy, s, font=font, fill=fill, anchor=anchor)


def box(x0, y0, x1, y1, fill=PANEL, outline=LINE, r=10, w=1):
    d.rounded_rectangle([x0, y0, x1, y1], radius=r, fill=fill, outline=outline, width=w)


def arrow(x0, y0, x1, y1, color=DIM, w=2):
    d.line([x0, y0, x1, y1], fill=color, width=w)
    # head
    import math
    ang = math.atan2(y1 - y0, x1 - x0)
    for da in (2.6, -2.6):
        d.line([x1, y1, x1 + 9 * math.cos(ang + da), y1 + 9 * math.sin(ang + da)], fill=color, width=w)


# ---------- title ----------
text((W // 2, 36), "HEIMDALL — cross-repo memory for AI coding agents", FONT_TITLE, FG, "mm")
text((W // 2, 68), "zero tokens at index time · CPU only · every hit verified against disk", FONT_SM, DIM, "mm")

# ================= TOP: pipeline =================
py0, py1 = 100, 330
box(40, py0, W - 40, py1, PANEL)

text((64, py0 + 16), "THE LOOP", FONT_H, ACCENT)

# left column: your edits
bx = lambda i: 70 + i * 300
labels = [
    ("YOUR EDITS", "edit · write · mv", DIM),
    ("RECONCILER", "single writer\nlevel triggered", ACCENT),
    ("CODE GRAPH", "tree-sitter\nper repo", DIM),
    ("EMBEDDINGS", "bge-m3 · CPU", DIM),
    ("INDEX", "sqlite + vec\none graph", GREEN),
]
for i, (t, sub, col) in enumerate(labels):
    x0 = bx(i) - 8
    x1 = x0 + 260
    by0, by1 = py0 + 60, py0 + 170
    box(x0, by0, x1, by1, fill=(28, 33, 42), outline=col if col != DIM else LINE, w=2 if col != DIM else 1)
    text(((x0 + x1) // 2, by0 + 22), t, FONT_H, col, "mm")
    for j, ln in enumerate(sub.split("\n")):
        text(((x0 + x1) // 2, by0 + 58 + j * 20), ln, FONT_SM, DIM, "mm")
    if i < len(labels) - 1:
        arrow(x1 + 6, (by0 + by1) // 2, bx(i + 1) - 14, (by0 + by1) / 2 if False else (by0 + by1) // 2, ACCENT)

# hint loop back over the top
d.arc([bx(0), py0 + 18, bx(4) + 252, py0 + 66], start=180, end=360, fill=YELLOW, width=2)
text((W // 2, py0 + 30), "hints flow in — nothing tells the graph WHAT changed, only THAT a path might have", FONT_XS, YELLOW, "mm")

# verdict bar under pipeline
vy = py1 - 44
text((70, vy), "VERDICTS ON EVERY HIT:", FONT_SM, DIM)
for i, (v, c) in enumerate([("STRONG", GREEN), ("path exists on disk now", DIM), ("·", DIM),
                            ("WEAK", YELLOW), ("plausible, unverified", DIM), ("·", DIM),
                            ("STALE", RED), ("dead path, pruned", DIM)]):
    x = 320 + sum(150 for _ in range(i))
    pass
# simpler: fixed positions
vx = 320
for v, c, note in [("STRONG", GREEN, "= path exists right now"), ("   WEAK", YELLOW, "= plausible"), ("   STALE", RED, "= pruned")]:
    text((vx, vy), v, FONT_SM, c)
    vx += d.textlength(v, font=FONT_SM) + 6
    text((vx, vy), note, FONT_SM, DIM)
    vx += d.textlength(note, font=FONT_SM) + 30

# ================= BOTTOM LEFT: BEFORE =================
by0, by1 = 370, 950
LX0, LX1 = 40, 780
RX0, RX1 = 820, W - 40

before_lines = [
    (">$ grep -r \"portfolio optimizer\" .", DIM),
    ("  grep: no match in this repo", DIM),
    ("", FG),
    (">$ ls ~/work/", DIM),
    ("  quant-bot  reports  api  site  scratch", DIM),
    ("", FG),
    (">$ find ~/work -name \"*.py\" | xargs grep -l EV", DIM),
    ("  /Users/deva/work/quant-bot/src/ev/jam.py", DIM),
    ("", FG),
    (">$ cat /Users/deva/work/quant-bot/src/ev/jam.py | head -50", DIM),
    ("", FG),
    (">$ cd ~/work/reports && grep -r \"tracker\" --include=\"*.py\"", DIM),
    ("  ...", DIM),
    ("", FG),
    ("># 15 commands later, still not sure it's the right file", RED),
]
after_lines = [
    (">$ kb_search \"portfolio optimization jam\"", ACCENT),
    ("", FG),
    (" 1. [STRONG] portfolio optimizer", GREEN),
    ("     ~/work/quant-bot/src/ev/jam.py", DIM),
    ("     heads-up jam/fold EV entry point", DIM),
    (" 2. [STRONG] excel tracker builder", GREEN),
    ("     ~/work/reports/excel/tracker.py", DIM),
    ("", FG),
    ("  STRONG = path exists on disk right now.", DIM),
    ("  Agent acts immediately. Done.", DIM),
]

def term_panel(x0, y0, x1, y1, title, lines, badge, badge_color):
    box(x0, y0, x1, y1)
    # title bar
    d.rounded_rectangle([x0, y0, x1, y0 + 40], radius=10, fill=(30, 36, 46))
    d.rectangle([x0, y0 + 20, x1, y0 + 40], fill=(30, 36, 46))
    text((x0 + 20, y0 + 11), title, FONT_H, FG)
    # badge top-right
    bw = int(d.textlength(badge, font=FONT_H)) + 30
    d.rounded_rectangle([x1 - bw - 16, y0 + 6, x1 - 16, y0 + 34], radius=8, outline=badge_color, width=2)
    text((x1 - 16 - bw / 2, y0 + 12), badge, FONT_H, badge_color, "mm" if False else "la")
    yy = y0 + 60
    for ln, col in lines:
        text((x0 + 24, yy), ln, FONT_SM, col)
        yy += 24
    return yy

y_end_b = term_panel(LX0, by0, LX1, by1, "BEFORE — agent without memory", before_lines, "15+ commands", RED)
text(((LX0 + LX1) // 2, by1 - 30), "orientation cost: minutes of context burned per session", FONT_SM, RED, "mm")

y_end_a = term_panel(RX0, by0, RX1, by1, "AFTER — agent with Heimdall", after_lines, "1 command", GREEN)
text(((RX0 + RX1) // 2, by1 - 30), "orientation cost: one verified search, straight to work", FONT_SM, GREEN, "mm")

# middle vs arrow
arrow(LX1 + 6, 660, RX0 - 6, 660, ACCENT, 3)
text(((LX1 + RX0) // 2, 636), "kb_search", FONT_H, ACCENT, "mm")
text(((LX1 + RX0) // 2, 682), "ranked · scoped ·\nverified", FONT_XS, DIM, "mm")

out = "/Users/arihantdeva/Repos/heimdall/assets/explainer.png"
os.makedirs(os.path.dirname(out), exist_ok=True)
img.save(out)
print(f"OK {out} {os.path.getsize(out)} bytes")
