"""Reads the Gemini subscription's remaining limits from agy for the LLM tab.

agy shows them only on its interactive screen (/usage, "Models & Quota"); there is no flag or JSON for it. This opens
agy in a pseudo-terminal in an empty folder of its own, types /usage, renders the screen with pyte (agy redraws only
what changes) and reads the GEMINI MODELS group: "Five Hour Limit Remaining" and "Weekly Limit Remaining", each a
percentage and "Refreshes in 2h 32m". Prints one JSON line:
    {"ok": true, "fiveHour": {"left": 93.29, "resetsInMin": 152}, "sevenDay": {"left": 38.38, "resetsInMin": 1275}}
or {"ok": false, "error": ...}. Needs pyte (run with the venv's python). Never answers a terms screen.

    ~/.local/share/edumaster-py/bin/python deploy/agy-quota.py
"""
import fcntl
import json
import os
import pty
import re
import select
import struct
import sys
import termios
import time

try:
    import pyte
except ImportError:
    print(json.dumps({"ok": False, "error": "pyte가 설치되어 있지 않습니다."}))
    sys.exit(0)

AGY = os.environ.get("AGY_BIN", os.path.expanduser("~/.local/bin/agy"))
WORKDIR = os.environ.get("AGY_QUOTA_DIR", os.path.expanduser("~/.local/share/edumaster-agy"))
ROWS, COLS = 60, 160
os.makedirs(WORKDIR, exist_ok=True)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(WORKDIR)
    os.execv(AGY, [AGY])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)


def text():
    return "\n".join(line.rstrip() for line in screen.display)


def pump(seconds, until=None):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                stream.feed(os.read(fd, 65536))
            except OSError:
                return False
        if until and until(text()):
            return True
    return False


def finish(obj):
    print(json.dumps(obj, ensure_ascii=False))
    try:
        os.kill(pid, 9)
    except OSError:
        pass
    sys.exit(0)


# "not signed in. Signing in..." flashes by while agy loads its sign-in; only its login menu means signed out.
ready = lambda t: "? for shortcuts" in t or "Do you trust" in t or "Terms of Service" in t or "Select login method" in t
if not pump(40, ready):
    finish({"ok": False, "error": "agy 화면이 열리지 않았습니다."})
t = text()
if "Select login method" in t:
    finish({"ok": False, "error": "agy가 로그인되어 있지 않습니다."})
if "Terms of Service" in t or "color scheme" in t:
    finish({"ok": False, "error": "agy 첫 실행 안내(약관)가 끝나지 않았습니다."})
if "Do you trust" in t:
    # Only this script's own empty folder is ever trusted.
    os.write(fd, b"\r")
    if not pump(20, lambda t: "? for shortcuts" in t):
        finish({"ok": False, "error": "agy 화면이 열리지 않았습니다."})
for ch in "/usage":
    os.write(fd, ch.encode())
    pump(0.3)
os.write(fd, b"\r")
group = lambda t: t.split("GEMINI MODELS", 1)[1].split("MODELS", 1)[0] if "GEMINI MODELS" in t else ""
if not pump(40, lambda t: "Five Hour Limit Remaining" in group(t) and re.search(r"Five Hour Limit Remaining[^%]*%", group(t), re.S)):
    finish({"ok": False, "error": "한도 화면을 읽지 못했습니다."})
pump(1.5)
g = group(text())


def window(name):
    m = re.search(name + r" Limit Remaining\s*\n[^\n]*?([\d.]+)%\s*\n\s*([^\n]+)", g)
    if not m:
        return None
    left = float(m.group(1))
    when = m.group(2).strip()
    minutes = None
    r = re.search(r"Refreshes in\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m)?", when)
    if r and any(r.groups()):
        d, h, mi = (int(x or 0) for x in r.groups())
        minutes = d * 1440 + h * 60 + mi
    return {"left": left, "resetsInMin": minutes}


five, week = window("Five Hour"), window("Weekly")
if five is None and week is None:
    finish({"ok": False, "error": "한도 값을 찾지 못했습니다."})
finish({"ok": True, "fiveHour": five, "sevenDay": week})
