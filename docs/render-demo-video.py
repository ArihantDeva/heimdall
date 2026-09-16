#!/usr/bin/env python3
"""Render heimdall-demo.mp4 — side-by-side agent session orientation:
without Heimdall (agent spirals through grep/find/ls) vs with Heimdall
(one kb_search, verified hits, straight to work). Terminal style: black bg,
Menlo monospace, cyan/green/red. Frames → ffmpeg → mp4. Deterministic."""
import subprocess, os
from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 900
FPS = 30
BLACK = (0, 0, 0)
CYAN = (127, 214, 247)
CYAN_DIM = (86, 156, 184)
WHITE = (232, 232, 232)
RED = (255, 107, 107)
GREEN = (126, 231, 135)
GREY = (120, 120, 120)
DARKGREY = (60, 60, 60)

F = lambda s: ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", s)
F_TITLE = F(34)
F_PANE = F(24)
F_TXT = F(19)
F_SM = F(17)

LH = 30

# ============ script ============
# Prompt shown in a banner above both panes.
PROMPT = "fix the vol-surface fitting bug — it regressed after the greeks refactor"

# Left pane: agent without memory — thrashes across repos.
WITHOUT = [
    ("❯ grep -rn \"vol surface\" ~/Repos/quant-bot/", 1.0, "wrong repo", RED),
    ("  no matches", 0.4, None, GREY),
    ("❯ grep -rn \"implied vol\" ~/Repos/", 1.2, "4 repos, 90s", RED),
    ("  ~/Repos/backtrader-fork/studies/vol.py", 0.5, None, GREY),
    ("  ~/Repos/deriv-pricing/src/svi.py", 0.4, None, GREY),
    ("❯ rg --no-ignore \"svi\" ~/Repos/deriv-pricing/", 0.9, None, GREY),
    ("❯ cat ~/Repos/deriv-pricing/src/svi.py | head -80", 0.9, None, GREY),
    ("❯ git -C ~/Repos/quant-bot log --oneline -20", 0.8, None, GREY),
    ("❯ # which repo has the greeks refactor? was it even", 0.9, None, GREY),
    ("❯ # this repo? checking git history across 4 clones…", 0.9, None, RED),
    ("❯ # agent still orienting — user watching spinner", 1.1, None, RED),
]

# Right pane: agent with Heimdall — orient, verify, edit.
WITH = [
    ("❯ kb_search \"vol surface fitting greeks refactor\"", 1.2, None, CYAN),
    ("", 0.3, None, None),
    ("  1. [STRONG] svi.py — raw vs calibrated params", 0.7, None, GREEN),
    ("     ~/Repos/deriv-pricing/src — as_of=2.1h fresh", 0.5, None, GREY),
    ("  2. [STRONG] greeks refactor session log", 0.7, None, GREEN),
    ("     ~/Repos/quant-bot — strike domain split, Feb 12", 0.5, None, GREY),
    ("  3. [REBUILT] tests/test_svi.py — moved → src/tests/", 0.6, None, CYAN),
    ("", 0.3, None, None),
    ("❯ edit ~/Repos/deriv-pricing/src/svi.py  # strike-domain fix", 1.0, None, WHITE),
    ("❯ pytest tests/test_svi.py -k calibrate", 0.8, None, WHITE),
    ("  12 passed in 3.2s", 0.6, None, GREEN),
    ("❯ # fixed in one session — memory knew where to look", 1.1, None, GREEN),
]

TOTAL_HOLD = 2.2


def draw_frame(left_n, left_partial, right_n, right_partial, elapsed):
    img = Image.new("RGB", (W, H), BLACK)
    d = ImageDraw.Draw(img)

    # title + prompt banner
    d.text((W // 2, 38), "SESSION ORIENTATION", font=F_TITLE, fill=CYAN, anchor="mm")
    d.text((W // 2, 84), f'❯ {PROMPT}', font=F_TXT, fill=WHITE, anchor="mm")

    # panes
    py0, py1 = 130, H - 90
    d.rectangle([40, py0, W // 2 - 20, py1], outline=DARKGREY, width=2)
    d.text((64, py0 + 14), "WITHOUT HEIMDALL", font=F_PANE, fill=RED)
    d.text((W // 2 - 44, py0 + 14), f"{elapsed:.0f}s burned", font=F_SM, fill=RED, anchor="ra")
    d.rectangle([W // 2 + 20, py0, W - 40, py1], outline=CYAN, width=2)
    d.text((W // 2 + 44, py0 + 14), "WITH HEIMDALL", font=F_PANE, fill=CYAN)
    d.text((W - 64, py0 + 14), f"{min(elapsed, 8.0):.1f}s", font=F_SM, fill=GREEN, anchor="ra")

    # left lines
    y = py0 + 60
    for i, (cmd, dur, note, col) in enumerate(WITHOUT):
        if i >= left_n:
            break
        if i == left_n - 1 and left_partial < 1:
            txt = cmd[:max(0, int(len(cmd) * left_partial))]
            d.text((64, y), txt + "▌", font=F_TXT, fill=col or WHITE)
        else:
            d.text((64, y), cmd, font=F_TXT, fill=col or WHITE)
        if note and i < left_n:
            d.text((W // 2 - 44, y), note, font=F_SM, fill=RED, anchor="ra")
        y += LH

    # right lines
    y = py0 + 60
    for i, (cmd, dur, note, col) in enumerate(WITH):
        if i >= right_n:
            break
        if i == right_n - 1 and right_partial < 1:
            txt = cmd[:max(0, int(len(cmd) * right_partial))]
            if txt:
                d.text((W // 2 + 44, y), txt + "▌", font=F_TXT, fill=col or WHITE)
        else:
            d.text((W // 2 + 44, y), cmd, font=F_TXT, fill=col or WHITE)
        y += LH

    # verdict strip
    d.line([(40, H - 70), (W - 40, H - 70)], fill=DARKGREY, width=2)
    if left_n >= len(WITHOUT):
        d.text((64, H - 56), "11+ commands · still orienting · bug unfixed", font=F_TXT, fill=RED)
    if right_n >= len(WITH):
        d.text((W // 2 + 44, H - 56), "1 search · bug fixed · tests green", font=F_TXT, fill=GREEN)
    d.text((W - 64, H - 56), "npm i @arihantdeva/heimdall", font=F_SM, fill=CYAN, anchor="ra")
    return img


# ============ timeline ============
tlw = sum(d for _, d, _, _ in WITHOUT)
tlr = sum(d for _, d, _, _ in WITH)
total = max(tlw, tlr) + TOTAL_HOLD


def state_at(t):
    ln, lp = 0, 1.0
    acc = 0.0
    for cmd, dur, _, _ in WITHOUT:
        if t >= acc + dur:
            ln += 1; acc += dur
        else:
            lp = (t - acc) / dur; break
    else:
        lp = 1.0
    rn, rp = 0, 1.0
    acc = 0.0
    for cmd, dur, _, _ in WITH:
        if t >= acc + dur:
            rn += 1; acc += dur
        else:
            rp = (t - acc) / dur; break
    else:
        rp = 1.0
    return ln, lp, rn, rp


frames_dir = "/tmp/heimdall-demo-frames"
os.makedirs(frames_dir, exist_ok=True)
# clean stale frames
for f in os.listdir(frames_dir):
    os.remove(os.path.join(frames_dir, f))
n_frames = int(total * FPS)
for f in range(n_frames):
    t = f / FPS
    ln, lp, rn, rp = state_at(t)
    img = draw_frame(ln, lp, rn, rp, t)
    img.save(f"{frames_dir}/f{f:05d}.png")

out = "/Users/arihantdeva/Repos/heimdall/docs/heimdall-demo.mp4"
subprocess.run([
    "ffmpeg", "-y", "-framerate", str(FPS), "-i", f"{frames_dir}/f%05d.png",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium",
    "-movflags", "+faststart", out
], check=True, capture_output=True)
print("saved", out, f"{n_frames} frames, {total:.1f}s")
