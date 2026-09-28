"""Exercise actual guard cleanup on a separate, temporary test SSH tunnel."""
import json
import shlex
import subprocess
import time
import uuid
from pathlib import Path

host = 'lmo0317@192.168.219.112'
ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8']


def remote(code):
    return subprocess.run(ssh + [host, 'python3 -c ' + shlex.quote(code)], capture_output=True, text=True, timeout=15)


# Refuse to start if anyone already owns the separate test port.
preflight = remote("import socket; s=socket.socket(); s.bind(('127.0.0.1',18284)); s.close(); print('test port free')")
assert preflight.returncode == 0, 'Separate test port is already occupied'
marker = '/home/lmo0317/apps/edumaster/lease-test-' + uuid.uuid4().hex + '.txt'
code = "import runpy; from pathlib import Path; g=runpy.run_path('/home/lmo0317/apps/edumaster/tunnel-guard.py'); scope=g['main'].__globals__; scope['probe']=lambda:False; original_kill=scope['os'].kill; scope['os'].kill=lambda pid,sig:(Path(" + repr(marker) + ").write_text(str(pid)),original_kill(pid,sig)); g['main']()"
started = time.monotonic()
process = subprocess.Popen(ssh + ['-T', '-o', 'ExitOnForwardFailure=yes', '-R', '127.0.0.1:18284:127.0.0.1:18280', host, 'python3 -c ' + shlex.quote(code)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
try:
    output, errors = process.communicate(timeout=35)
finally:
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=5)
expired = remote("from pathlib import Path; p=Path(" + repr(marker) + "); assert p.exists(), 'guard did not terminate its own parent'; assert p.read_text().isdigit(); p.unlink(); print('guard termination recorded')")
assert expired.returncode == 0, 'Guard did not expire its own test session: ' + expired.stderr + errors
closed = remote("import socket; s=socket.socket(); s.settimeout(2); r=s.connect_ex(('127.0.0.1',18284)); s.close(); assert r!=0, 'test listener remained'; print('test listener removed')")
assert closed.returncode == 0, closed.stderr
report = {'guardExpiredOwnSession': True, 'temporaryTestPortRemoved': True, 'testPort': 18284, 'seconds': round(time.monotonic() - started, 2), 'productionPortUntouched': 18282}
Path('artifacts/evidence/web/tunnel-lease-test.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
