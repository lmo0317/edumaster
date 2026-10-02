"""Signs the server's Antigravity CLI (agy) in to the teacher's Google account without an SSH session (LLM tab).

Runs `agy` in a pseudo-terminal, picks "Google OAuth" on its first-run screen, prints the sign-in link as a JSON
line, reads the code the teacher pasted from stdin and types it in. Then it checks that agy works (`agy models`
lists Gemini models) and writes the marker file given as the first argument. Prints {"ok": true} or
{"ok": false, "error": ...}. The code is never printed. agy keeps the sign-in itself (in the system keyring).

    python3 deploy/agy-login.py data/agy-connected.json
"""
import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

MARKER = sys.argv[1]
AGY = os.environ.get("AGY_BIN", os.path.expanduser("~/.local/bin/agy"))
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b_[^\x1b]*\x1b\\")


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def works():
    """agy answers with its model list: signed in."""
    try:
        r = subprocess.run([AGY, "models"], capture_output=True, text=True, timeout=90, cwd="/tmp")
    except Exception:
        return False
    return r.returncode == 0 and "gemini-" in r.stdout


def done(ok, error=""):
    if ok:
        with os.fdopen(os.open(MARKER, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
            json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f)
        say({"ok": True})
    else:
        say({"ok": False, "error": error})
    sys.exit(0)


# Already signed in (e.g. once over SSH): nothing to do.
if works():
    say({"url": "-"})
    done(True)

pid, fd = pty.fork()
if pid == 0:
    os.chdir("/tmp")
    os.execv(AGY, [AGY])
# A wide terminal keeps the link on one line.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 2000, 0, 0))
out = b""


def text():
    return ANSI.sub("", out.decode("utf-8", "replace")).replace("\r", "")


def pump(seconds, until=None):
    global out
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                out += os.read(fd, 65536)
            except OSError:
                return False
        if until and until(text()):
            return True
    return False


def stop():
    try:
        os.kill(pid, 9)
    except OSError:
        pass


if not pump(60, lambda t: "Google OAuth" in t or "accounts.google.com" in t):
    stop()
    done(False, "agy의 로그인 화면이 나오지 않았습니다.")
if "accounts.google.com" not in text():
    os.write(fd, b"\r")  # 1. Google OAuth
    if not pump(30, lambda t: re.search(r"https://accounts\.google\.com/\S+", t)):
        stop()
        done(False, "로그인 링크를 받지 못했습니다.")
link = re.search(r"https://accounts\.google\.com/\S+", text()).group(0)
say({"url": link})

code = sys.stdin.readline().strip()
if not code:
    stop()
    done(False, "코드가 비어 있습니다.")
mark = len(text())
# Typed, then Enter separately (a paste with Enter in the same chunk can stay in the field).
os.write(fd, code.encode())
pump(1.5)
os.write(fd, b"\r")
pump(25, lambda t: re.search(r"error|invalid|failed", t[mark:], re.I))
after = text()[mark:].replace(code, "[CODE]")
stop()
if works():
    done(True)
reason = next((" ".join(line.split()) for line in after.splitlines() if re.search(r"error|invalid|failed", line, re.I)), "")
done(False, reason[:200] or "코드를 넣었지만 agy가 로그인되지 않았습니다. 코드를 다시 받아 시도해 주세요.")
