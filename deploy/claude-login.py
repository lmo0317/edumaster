"""Signs the server's Claude Code in to a Claude subscription without an SSH session (used by the 시스템 page).

Runs `claude setup-token` in a pseudo-terminal (it needs one), prints the sign-in link as a JSON line, reads the
code the teacher pasted from stdin, types it into the CLI, and saves the long-lived token it prints to the file
given as the first argument (mode 600). Prints {"ok": true} or {"ok": false, "error": ...}. The code and the
token are never printed.

    python3 deploy/claude-login.py data/claude-oauth-token.txt
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

TOKEN_FILE = sys.argv[1]
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


pid, fd = pty.fork()
if pid == 0:
    os.execvp(os.environ.get("CLAUDE_BIN", "claude"), [os.environ.get("CLAUDE_BIN", "claude"), "setup-token"])

# A wide terminal keeps the link and the token on one line each.
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))
out = b""


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


def text():
    return ANSI.sub("", out.decode("utf-8", "replace")).replace("\r", "")


def finish(obj):
    say(obj)
    try:
        os.kill(pid, 9)
    except OSError:
        pass
    sys.exit(0)


# The CLI draws with cursor moves, so the spaces of its prompt may not come through.
if not pump(60, lambda t: "Pastecode" in t.replace(" ", "")):
    finish({"ok": False, "error": "로그인 링크를 받지 못했습니다."})
link = re.search(r"https://claude\.com/cai/oauth/authorize\S+", text())
if not link:
    finish({"ok": False, "error": "로그인 링크를 찾지 못했습니다."})
say({"url": link.group(0)})

code = sys.stdin.readline().strip()
if not code:
    finish({"ok": False, "error": "코드가 비어 있습니다."})
mark = len(text())
# A long code arrives as one chunk and the CLI takes it as a paste: an Enter in the same chunk becomes part of the
# pasted text (a real code then sat in the field with nothing happening). Type it, then press Enter separately.
os.write(fd, code.encode())
pump(1.5)
os.write(fd, b"\r")
if not pump(10, lambda t: len(t) > mark + len(code) + 40 or "error" in t[mark:].lower()):
    os.write(fd, b"\r")
token_re = re.compile(r"sk-ant-oat[0-9A-Za-z_-]+")
# The token may be wrapped and drawn inside a box: drop whitespace and box-drawing characters before looking.
squash = lambda t: re.sub(r"[\s─-╿|]", "", t)
pump(80, lambda t: token_re.search(squash(t[mark:])) or "error" in t[mark:].lower())
after = text()[mark:]
token = token_re.search(squash(after))
# What the CLI said after the code, with the code and any token masked, for diagnosing a failed login.
log = os.path.join(os.path.dirname(os.path.abspath(TOKEN_FILE)), "claude-login.log")
masked = re.sub(r"\*{4,}\S*", "[CODE]", token_re.sub("[TOKEN]", after.replace(code, "[CODE]")))  # the CLI echoes the code's tail
with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
    f.write("\n".join(" ".join(line.split()) for line in masked.splitlines() if line.strip())[-4000:])
if token:
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    with os.fdopen(os.open(TOKEN_FILE, flags, 0o600), "w") as f:
        f.write(token.group(0) + "\n")
    os.chmod(TOKEN_FILE, 0o600)
    finish({"ok": True})
reason = next((" ".join(line.split()) for line in after.splitlines() if "error" in line.lower()), "")
finish({"ok": False, "error": reason[:200] or "코드를 넣은 뒤 Claude가 응답하지 않았습니다."})
