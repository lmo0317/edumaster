"""Deploy the user-owned gateway, without passwords or nginx changes."""
import subprocess
import sys
from pathlib import Path
host='lmo0317@192.168.219.112'
def run(command):
    r=subprocess.run(command,text=True,capture_output=True,encoding='utf-8')
    if r.returncode:raise RuntimeError(r.stderr.strip() or 'Deployment failed')
    return r.stdout
def ssh(command):return run(['ssh','-o','BatchMode=yes',host,command])
base='/home/lmo0317/apps/edumaster'
sample_metadata=Path('docs/샘플/샘플자료/추출정보.json')
if sample_metadata.exists():
    print(run([sys.executable, '-X', 'utf8', 'scripts/sync-pdf-samples.py']).strip())
else:
    print('Sample metadata is not present; preserving existing verified web sample assets.')
ssh('mkdir -p '+base+'/public ~/.config/systemd/user')
run(['tar','--exclude=./samples/reaction-text.png','--exclude=./samples/structure-text.png','-czf','artifacts/edumaster-web-assets.tar.gz','-C','src/EduMaster.Web/wwwroot','.'])
run(['scp','-o','BatchMode=yes','artifacts/edumaster-web-assets.tar.gz',host+':'+base+'/static.tar.gz'])
if '--static-only' in sys.argv:
    print(ssh('set -e; tar -xzf '+base+'/static.tar.gz -C '+base+'/public; systemctl --user is-active edumaster-web planner kidsnote'))
    print('Static assets updated; application and gateway processes preserved.')
    sys.exit(0)
run(['scp','-o','BatchMode=yes','scripts/tunnel-guard.py',host+':'+base+'/tunnel-guard.py'])
run(['scp','-o','BatchMode=yes','scripts/web-gateway.cjs',host+':'+base+'/web-gateway.cjs'])
unit='''[Unit]
Description=EduMaster web preview gateway
After=network.target

[Service]
WorkingDirectory=/home/lmo0317/apps/edumaster
ExecStart=/usr/bin/node /home/lmo0317/apps/edumaster/web-gateway.cjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
'''
unit_path=Path('artifacts/edumaster-web.service');unit_path.write_text(unit,encoding='utf-8')
run(['scp','-o','BatchMode=yes',str(unit_path),host+':/home/lmo0317/.config/systemd/user/edumaster-web.service'])
print(ssh('set -e; tar -xzf '+base+'/static.tar.gz -C '+base+'/public; node --check '+base+'/web-gateway.cjs; systemctl --user daemon-reload; systemctl --user enable --now edumaster-web; systemctl --user restart edumaster-web; systemctl --user is-active edumaster-web planner kidsnote'))
