#!/usr/bin/env python3
"""Generate VaultPilot pitch-video slides (1280x720 PNGs) with PIL."""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1280, 720
BG = (11, 15, 23)
PANEL = (18, 24, 38)
LINE = (31, 42, 61)
TEXT = (230, 237, 243)
MUTED = (139, 152, 171)
GREEN = (20, 241, 149)
PURPLE = (153, 69, 255)
BLUE = (74, 168, 255)
VIOLET = (192, 132, 252)
WARN = (255, 180, 84)

FONT_DIRS = [
    "/usr/share/fonts/truetype/dejavu/",
    "/usr/share/fonts/dejavu/",
]
def font(name, size):
    for d in FONT_DIRS:
        p = os.path.join(d, name)
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def F(size, bold=False, mono=False):
    if mono:
        return font("DejaVuSansMono-Bold.ttf" if bold else "DejaVuSansMono.ttf", size)
    return font("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", size)

def base(title=None):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    # subtle top gradient band
    for i in range(4):
        d.line([(0, i), (W, i)], fill=(13 + i, 20 + i, 32 + i))
    d.rectangle([0, 0, W, 3], fill=PURPLE)
    d.rectangle([0, 3, W, 5], fill=GREEN)
    return img, d

def footer(d, n, total=7):
    d.text((40, H - 42), "VaultPilot · Solana devnet demo · built by an AI agent, disclosed", font=F(17), fill=MUTED)
    d.text((W - 90, H - 42), f"{n} / {total}", font=F(17), fill=MUTED)

def bullets(d, items, x, y, maxw=1150, lh=44, fs=27, color=TEXT):
    f = F(fs)
    for it in items:
        if isinstance(it, tuple):
            txt, c = it
        else:
            txt, c = it, color
        d.ellipse([x, y + fs * 0.32, x + 10, y + fs * 0.32 + 10], fill=GREEN)
        # simple wrap
        words, lines, cur = txt.split(), [], ""
        for w2 in words:
            t = (cur + " " + w2).strip()
            if d.textlength(t, font=f) > maxw:
                lines.append(cur); cur = w2
            else:
                cur = t
        lines.append(cur)
        for ln in lines:
            d.text((x + 26, y), ln, font=f, fill=c)
            y += lh
        y += 12
    return y

def panel(d, box, title=None):
    d.rounded_rectangle(box, radius=14, fill=PANEL, outline=LINE, width=2)
    if title:
        d.text((box[0] + 20, box[1] + 14), title, font=F(17, True), fill=MUTED)

# ---------- slide 1: title ----------
img, d = base()
# VP monogram tiles (no emoji font in container - use letterforms)
for i, (c, col) in enumerate([("V", PURPLE), ("P", GREEN)]):
    x0 = W//2 - 110 + i * 110
    d.rounded_rectangle([x0, 150, x0 + 100, 250], radius=24, fill=col)
    d.text((x0 + 27, 168), c, font=F(58, True), fill=(11, 15, 23))
d.rounded_rectangle([W//2 + 110, 150, W//2 + 320, 250], radius=24, outline=LINE, width=3)
d.text((W//2 + 138, 168), "70/20/10", font=F(30, True, True), fill=TEXT)
d.text((W//2-436, 290), "VaultPilot", font=F(74, True), fill=TEXT)
d.text((W//2-434, 385), "the autonomous earnings treasury for AI agents", font=F(31), fill=MUTED)
d.rounded_rectangle([W//2-434, 470, W//2+434, 530], radius=12, outline=LINE, width=2)
d.text((W//2-414, 487), "Solana program · devnet demo · immutable 70/20/10 policy · on-chain audit trail", font=F(20, True), fill=GREEN)
d.rounded_rectangle([W//2-434, 550, W//2+270, 596], radius=12, outline=WARN, width=2)
d.text((W//2-414, 560), "built end-to-end by an autonomous AI agent — disclosed", font=F(19, True), fill=WARN)
img.save("assets/slide1.png")

# ---------- slide 2: problem ----------
img, d = base()
d.text((60, 70), "The problem: agent earnings have no rules", font=F(40, True), fill=TEXT)
bullets(d, [
    "AI agents earn programmatically: bounties, API revenue, affiliate payouts.",
    "The money lands in a plain wallet — no policy, no separation, no audit trail.",
    ("A spending policy the agent merely \u201cpromises\u201d to follow is not enforceable.", WARN),
], 60, 170, lh=52)
panel(d, [60, 400, 1220, 640], "today")
d.text((90, 445), "bounty payout  ──▶  [ one wallet, everything mixed ]", font=F(27, True, True), fill=TEXT)
d.text((90, 500), "spend policy = a promise in a system prompt  \u26a0", font=F(27, True, True), fill=WARN)
d.text((90, 555), "history = whatever the operator says it was", font=F(27, True, True), fill=MUTED)
footer(d, 2)
img.save("assets/slide2.png")

# ---------- slide 3: how it works ----------
img, d = base()
d.text((60, 60), "How VaultPilot works", font=F(40, True), fill=TEXT)
# policy box
panel(d, [60, 160, 400, 330], "policy PDA · immutable")
d.text((84, 205), "operating  7000 bps", font=F(24, True, True), fill=GREEN)
d.text((84, 245), "reserve     2000 bps", font=F(24, True, True), fill=BLUE)
d.text((84, 285), "treasury   1000 bps", font=F(24, True, True), fill=VIOLET)
# instruction box
panel(d, [440, 160, 850, 330], "one atomic instruction")
d.text((464, 205), "deposit_and_split()", font=F(23, True, True), fill=TEXT)
d.text((464, 245), "share = amount×bps/10k", font=F(20, True, True), fill=MUTED)
d.text((464, 285), "vault ends at 0 — no pool", font=F(20, True, True), fill=GREEN)
# outputs (short labels, guaranteed to fit)
for i, (label, c) in enumerate([("operating · 70%", GREEN), ("reserve · 20%", BLUE), ("treasury · 10%", VIOLET)]):
    panel(d, [890, 160 + i * 62, 1220, 210 + i * 62])
    d.text((912, 174 + i * 62), label, font=F(22, True, True), fill=c)
panel(d, [890, 356, 1220, 406])
d.text((912, 370), "split · audit", font=F(22, True, True), fill=TEXT)
d.text((60, 380), "flow:  deposit in  ─▶  atomic split  ─▶  record written", font=F(22, True, True), fill=MUTED)
panel(d, [60, 450, 1220, 640], "guarantees")
bullets(d, [
    "Policy is written once on-chain and cannot be changed — not even by the owner.",
    "Every derived account is re-validated inside the program on every deposit.",
    "Each deposit appends a permanent on-chain record: amount, splits, depositor, time.",
], 80, 495, lh=40, fs=23)
footer(d, 3)
img.save("assets/slide3.png")

# ---------- slide 4: verified evidence ----------
img, d = base()
d.text((60, 60), "Verified: tests pass, splits are exact", font=F(40, True), fill=TEXT)
panel(d, [60, 150, 610, 420], "integration suite · live validator")
d.text((84, 195), "RESULT: 6 passed, 0 failed", font=F(30, True, True), fill=GREEN)
d.text((84, 255), "✔ bad policy (sum 9000) rejected  0x1", font=F(22, True, True), fill=TEXT)
d.text((84, 293), "✔ 1.5 SOL → 1.05 / 0.30 / 0.15 exact", font=F(22, True, True), fill=TEXT)
d.text((84, 331), "✔ fake vault rejected 0x4", font=F(22, True, True), fill=TEXT)
d.text((84, 369), "✔ vault residue after split: 0", font=F(22, True, True), fill=TEXT)
panel(d, [650, 150, 1220, 420], "no dust lost (real test)")
d.text((674, 195), "deposit      777 777 lamports", font=F(24, True, True), fill=TEXT)
d.text((674, 245), "operating →  544 443", font=F(24, True, True), fill=GREEN)
d.text((674, 285), "reserve    →  155 555", font=F(24, True, True), fill=BLUE)
d.text((674, 325), "treasury  →   77 779  (dust)", font=F(24, True, True), fill=VIOLET)
d.text((674, 372), "sum = 777 777 ✔", font=F(22, True, True), fill=MUTED)
panel(d, [60, 460, 1220, 640], "on devnet (test tokens only)")
d.text((84, 502), "program   AWdkgjxyu5hV45FXGpw15NMS4fee55CVfdCaUPLHicCw", font=F(20, True, True), fill=MUTED)
d.text((84, 540), "vault PDA GxoM9NgmtFzhQsP5D6nDrEPb5caLBLVKyiDPvVyUTgnC", font=F(20, True, True), fill=MUTED)
d.text((84, 578), "all deposits + splits verifiable on Solana Explorer · cluster=devnet", font=F(20, True, True), fill=GREEN)
footer(d, 4)
img.save("assets/slide4.png")

# ---------- slide 5: origin story ----------
img, d = base()
d.text((60, 60), "Why this exists: our own ledger", font=F(40, True), fill=TEXT)
rows = [
    ("$0.26", "first platform credit — the agent WITHDREW the claim when the\nplatform's ledger API showed 0. A UI number is not evidence.", WARN),
    ("17 min", "first open-source PR (#3244, security dep bumps, 222/222 tests\npassing) — closed unmerged in 17 minutes. Logged, not hidden.", BLUE),
    ("2×", "the optimistic-UI lesson: client-side renders mistaken for reality.\nAn on-chain record is a confirmation nobody can retro-edit.", GREEN),
]
y = 160
for big, txt, c in rows:
    panel(d, [60, y, 1220, y + 145])
    d.text((90, y + 40), big, font=F(44, True), fill=c)
    for i, ln in enumerate(txt.split("\n")):
        d.text((300, y + 32 + i * 34), ln, font=F(23), fill=TEXT)
    y += 165
d.text((60, y + 4), "VaultPilot = that lesson as program logic: policy + audit trail enforced by Solana.", font=F(24, True, True), fill=TEXT)
footer(d, 5)
img.save("assets/slide5.png")

# ---------- slide 6: honesty panel ----------
img, d = base()
d.text((60, 70), "Honest disclosure", font=F(40, True), fill=WARN)
items = [
    ("built end-to-end by an autonomous AI agent (henry-becker-gh)", "with human direction & review · public €0→revenue experiment"),
    ("no users, no revenue, no traction — nothing fabricated", "every number in the repo is a test result or an on-chain fact"),
    ("all tokens are devnet TEST tokens from the public faucet", "no real value anywhere; mainnet would require an audit first"),
    ("tests + on-chain records are the only claims we make", "6/6 integration checks · policy validation · exact splits"),
]
y = 170
for a, b in items:
    panel(d, [60, y, 1220, y + 100])
    d.text((90, y + 18), "▪ " + a, font=F(25, True, True), fill=TEXT)
    d.text((116, y + 58), b, font=F(20), fill=MUTED)
    y += 116
footer(d, 6)
img.save("assets/slide6.png")

# ---------- slide 7: roadmap + links ----------
img, d = base()
d.text((60, 70), "Roadmap & links", font=F(40, True), fill=TEXT)
bullets(d, [
    "SPL-token support (USDC earnings), not just native SOL.",
    "Enforceable withdrawals: time-locked treasury, spend limits.",
    "Multi-agent registry: one policy per agent, portable history.",
    "Independent audit before any mainnet deployment.",
], 60, 170, lh=48, fs=26)
panel(d, [60, 430, 1220, 560], "try it")
d.text((90, 470), "github.com/henry-becker-gh/vaultpilot", font=F(28, True, True), fill=BLUE)
d.text((90, 515), "henry-becker-gh.github.io/vaultpilot   ·   live devnet dashboard", font=F(24, True, True), fill=GREEN)
d.text((60, 596), "VaultPilot — an AI agent's treasury, enforced by Solana instead of by promise.", font=F(26, True, True), fill=TEXT)
footer(d, 7)
img.save("assets/slide7.png")

print("slides written:", sorted(f for f in os.listdir("assets") if f.startswith("slide")))
