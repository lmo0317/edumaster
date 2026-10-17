"""Lease for this SSH session's EduMaster reverse tunnel; no credentials needed.

Run on the server as the remote command of the PC's tunnel (scripts/start-web.ps1). While the PC model answers on
127.0.0.1:18283 the session stays; after two minutes without an answer it closes, and the PC watcher opens a new one.
"""
import os
import pwd
import signal
import subprocess
import time
import urllib.error
import urllib.request


def probe():
    try:
        with urllib.request.urlopen('http://127.0.0.1:18283/v1/models', timeout=4) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def validate_parent(parent_pid):
    if parent_pid <= 1 or os.getppid() != parent_pid:
        raise RuntimeError('SSH session parent changed')
    user = pwd.getpwuid(os.getuid()).pw_name
    parent_uid = subprocess.check_output(['ps', '-p', str(parent_pid), '-o', 'euid='], text=True).strip()
    if user != 'lmo0317' or parent_uid != str(os.getuid()):
        raise RuntimeError('SSH session ownership mismatch')
    args = subprocess.check_output(['ps', '-p', str(parent_pid), '-o', 'args='], text=True).strip()
    if args != 'sshd: lmo0317@notty':
        raise RuntimeError('Parent is not this dedicated SSH command session')


# A model reading an image (encoded on the CPU) answers nothing for half a minute or more; three missed probes
# (about 25 s) closed the tunnel under both Qwen runs of 모델 비교 3차 (2026-10-17). A PC that is gone stays silent.
SILENT_LIMIT = 120


def monitor(check, pause, terminate, clock=time.monotonic):
    since = None
    while True:
        if check():
            since = None
        elif since is None:
            since = clock()
        elif clock() - since >= SILENT_LIMIT:
            terminate()
            return
        pause(5)


def main():
    parent_pid = os.getppid()
    validate_parent(parent_pid)
    time.sleep(8)

    def terminate():
        # Kill only our direct, same-user SSH parent. Its listener then closes
        # even if TCP cannot notice that the PC vanished or changed networks.
        validate_parent(parent_pid)
        print('EduMaster tunnel lease expired; closing this SSH session', flush=True)
        os.kill(parent_pid, signal.SIGTERM)

    monitor(probe, time.sleep, terminate)


if __name__ == '__main__':
    main()
