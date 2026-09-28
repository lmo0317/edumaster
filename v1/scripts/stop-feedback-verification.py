"""Stop only this task's idle isolated test server, never production."""
from pathlib import Path
import os,signal
test=Path('/home/lmo0317/apps/edumaster/feedback-verification/v2-api')
pid=int((test/'pid.txt').read_text().strip())
process=Path('/proc')/str(pid)
if process.exists():
    if (process/'cwd').resolve()!=test.resolve():
        raise RuntimeError('Unexpected process directory: not stopping')
    os.kill(pid,signal.SIGTERM)
    print('Isolated test server stopped; production unchanged')
else:print('Isolated test server already stopped')
