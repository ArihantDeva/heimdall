#!/usr/bin/env python3
"""Render deterministic Heimdall demo GIF from real captured output.
Rolling terminal buffer (oldest lines dropped when full) so EVERY storyboard
step is visible; type-effect frames per command; per-step pacing durations."""
import os, shutil
from PIL import Image, ImageDraw, ImageFont

W, H = 1100, 520
BG = (13, 17, 23)
FG = (230, 237, 243)
ACCENT = (88, 166, 255)
DIM = (139, 148, 158)
MARGIN = 40
LINE_H = 24
VISIBLE = (H - 2 * MARGIN) // LINE_H  # lines that fit

FONT = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 18)
FONT_SM = ImageFont.truetype("/System/Library/Fonts/Menlo.ttc", 15)

STEPS = [
    ("cmd", "heimdall doctor", 12),
    ("out", "/tmp/demo-doctor.txt", 8),
    ("cmd", 'heimdall search "portfolio optimization" -n 3', 10),
    ("out", "/tmp/demo-out1.txt", 30),
    ("cmd", 'heimdall search "excel tracker portfolio" -n 3', 10),
    ("out", "/tmp/demo-out3.txt", 30),
    ("cmd", "heimdall insert --title \"jam_opt EV optimizer\" --body \"~/Repos/poker-bot/tools -- heads-up jam/fold EV optimizer\" --keywords poker,optimize", 8),
    ("out", "/tmp/demo-ins.txt", 20),
    ("cmd", 'heimdall search "jam EV optimizer" -n 3', 10),
    ("out", "/tmp/demo-out2.txt", 30),
    ("cmd", "heimdall verify --deep", 8),
    ("out", "/tmp/demo-verify.txt", 20),
]


def read_out(path):
    try:
        with open(path) as f:
            return [l.rstrip("\n") for l in f.read().splitlines()]
    except FileNotFoundError:
        return [f"[missing {path}]"]


def render(lines, cursor_on):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    y = MARGIN
    for ln in lines:
        if y > H - 10:
            break
        d.text((MARGIN, y), ln, font=FONT_SM, fill=DIM)
        y += LINE_H
    if cursor_on:
        cy = MARGIN + len(lines) * LINE_H
        if cy < H - 10:
            d.rectangle([MARGIN, cy, MARGIN + 10, cy + 16], fill=FG)
    return img


def push(buffer, lines):
    buffer.extend(lines)
    # keep only what fits
    del buffer[:max(0, len(buffer) - VISIBLE)]


buffer = []
frames = []
durations = []

for kind, payload, wait in STEPS:
    if kind == "cmd":
        full = "> " + payload
        # type effect (3 frames) then full command
        for frac in (0.4, 0.7, 1.0):
            shown = full[:int(len(full) * frac)]
            tmp = list(buffer) + [shown]
            frames.append(render(tmp, True))
            durations.append(140)
        push(buffer, [full])
        frames.append(render(buffer, False))
        durations.append(max(1, wait * 100 - 420))
    else:
        lines = read_out(payload)
        push(buffer, lines)
        frames.append(render(buffer, False))
        durations.append(300)
        # blink cursor a couple times, then long hold
        frames.append(render(buffer, True))
        durations.append(180)
        frames.append(render(buffer, False))
        durations.append(120)
        frames.append(render(buffer, True))
        durations.append(180)
        frames.append(render(buffer, False))
        durations.append(max(1, wait * 100 - 780))

out = "/Users/arihantdeva/Repos/heimdall/assets/demo.gif"
os.makedirs(os.path.dirname(out), exist_ok=True)
frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0)
print(f"OK frames={len(frames)} bytes={os.path.getsize(out)}")
