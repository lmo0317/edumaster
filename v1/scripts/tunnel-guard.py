"""Lease for this SSH session's EduMaster reverse tunnel; no credentials needed."""
import os
import pwd
import signal
import subprocess
import time
import urllib.error
import urllib.request


def probe():
    try:
        for port in (18283, 18284):
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/v1/models', timeout=4) as response:
                if response.status != 200:
                    return False
        return True
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


def monitor(check, pause, terminate):
    failures = 0
    while True:
        failures = 0 if check() else failures + 1
        if failures >= 3:
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
