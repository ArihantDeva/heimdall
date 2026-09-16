#!/usr/bin/env python3
"""Render heimdall-comparison.png — terminal-style benchmark card (black bg,
cyan monospace, block-character bars) in the theme of the Claude 3.7
benchmark graphic. Deterministic PIL."""
from PIL import Image, ImageDraw, ImageFont

W, H = 1500, 1050
BLACK = (0, 0, 0)
CYAN = (127, 214, 247)      # section headers, bars
CYAN_DIM = (86, 156, 184)   # secondary cyan
WHITE = (232, 232, 232)
RED = (255, 107, 107)
GREY = (120, 120, 120)

F = lambda s: ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", s)
F_TITLE = F(44)
F_SUB = F(22)
F_HEAD = F(26)
F_ROW = F(24)
F_VAL = F(24)
F_SM = F(19)

img = Image.new("RGB", (W, H), BLACK)
d = ImageDraw.Draw(img)


def text(xy, s, font=F_VAL, fill=WHITE, anchor="la"):
    d.text(xy, s, font=font, fill=fill, anchor=anchor)


# ---------- title ----------
text((W // 2, 56), "HEIMDALL vs OTHER MEMORY SYSTEMS", F_TITLE, CYAN, "mm")
text((W // 2, 102), "zero-token indexing · CPU only · every hit verified against disk", F_SUB, GREY, "mm")

# ---------- capability bars ----------
# Each capability: Heimdall wins = full cyan bar; others get short/grey bars or red X.
Y = 150
BAR_X0 = 540          # bars start after labels
BAR_X1 = 1100         # bar track end (value text gets the right margin)
BAR_H = 30

BLOCKS = [
    # (label, [(name, frac, color, value_text)])
    ("CROSS-REPO MEMORY", [
        ("Heimdall", 1.00, CYAN, "all repos, one graph"),
        ("mem0", 0.18, CYAN_DIM, "per-app"),
        ("Zep / Letta", 0.18, CYAN_DIM, "per-agent"),
        ("Vector RAG", 0.18, CYAN_DIM, "per-corpus"),
        ("Claude Memory", 0.18, CYAN_DIM, "per-chat"),
    ]),
    ("INDEXING TOKEN COST", [
        ("Heimdall", 1.00, CYAN, "ZERO"),
        ("mem0", 0.55, RED, "LLM per op"),
        ("Zep / Letta", 0.55, RED, "LLM per op"),
        ("Vector RAG", 0.35, RED, "embed tokens"),
        ("Claude Memory", 0.55, RED, "LLM summarize"),
    ]),
    ("TRUST VERDICTS ON HITS", [
        ("Heimdall", 1.00, CYAN, "STRONG / WEAK / REBUILT / STALE"),
        ("mem0", 0.05, GREY, "none"),
        ("Zep / Letta", 0.05, GREY, "none"),
        ("Vector RAG", 0.15, GREY, "sim score only"),
        ("Claude Memory", 0.05, GREY, "none"),
    ]),
    ("SELF-HEALING (MOVED FILES)", [
        ("Heimdall", 1.00, CYAN, "re-anchors automatically"),
        ("mem0", 0.05, GREY, "no"),
        ("Zep / Letta", 0.05, GREY, "no"),
        ("Vector RAG", 0.05, RED, "stale chunks rank forever"),
        ("Claude Memory", 0.05, GREY, "no"),
    ]),
    ("SOURCE STAYS LOCAL", [
        ("Heimdall", 1.00, CYAN, "never leaves disk"),
        ("mem0", 0.05, RED, "sent to LLM"),
        ("Zep / Letta", 0.05, RED, "sent to LLM"),
        ("Vector RAG", 0.40, CYAN_DIM, "if self-hosted"),
        ("Claude Memory", 0.05, RED, "cloud"),
    ]),
]

for label, rows in BLOCKS:
    # section header with box-drawing rule
    hdr = f"── {label} "
    text((80, Y), hdr, F_HEAD, CYAN)
    w = d.textlength(hdr, font=F_HEAD)
    d.line([(80 + w + 10, Y + 16), (W - 80, Y + 16)], fill=(45, 45, 45), width=2)
    Y += 52
    for name, frac, color, vtxt in rows:
        # name column
        text((110, Y + 4), name, F_ROW, GREY)
        # value text after bar
        # bar: block chars
        track = int((BAR_X1 - BAR_X0) / 14)  # block char width 14px at 24pt
        filled = max(1, int(track * frac))
        bar = "█" * filled + "░" * (track - filled)
        text((BAR_X0, Y + 2), bar, F_VAL, color)
        # value label right after bar
        text((BAR_X1 + 16, Y + 4), vtxt, F_SM, color if color != GREY else GREY)
        Y += 40
    Y += 26

# ---------- footer ----------
d.line([(80, H - 120), (W - 80, H - 120)], fill=(45, 45, 45), width=2)
text((80, H - 96), "npm i @arihantdeva/heimdall", F_HEAD, CYAN)
text((80, H - 58), "github.com/ArihantDeva/heimdall · MIT · v0.10.0", F_SM, GREY)
text((W - 80, H - 96), "0.10.0", F_HEAD, CYAN, "ra")
text((W - 80, H - 58), "344/344 tests green", F_SM, GREY, "ra")

img.save("/Users/arihantdeva/Repos/heimdall/docs/heimdall-comparison.png")
print("saved", W, H)
