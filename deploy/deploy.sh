#!/usr/bin/env bash
# Deploys EduMaster to the 112 server (run from Git Bash on the dev PC). Keeps the server's data/ folder.
# eval/reports goes along (the 시스템 page lists them). A file the server changed after the shipped copy (a report
# made or rechecked there) is kept: shipping an older local copy once wiped the solution-review results.
set -euo pipefail
HOST=lmo0317@192.168.219.112
APP=/home/lmo0317/apps/edumaster
cd "$(dirname "$0")/.."
tar czf /tmp/edumaster.tgz --exclude=node_modules --exclude=data --exclude=data-mock --exclude=test --exclude=eval/.work package.json package-lock.json server public deploy scripts eval
scp -q /tmp/edumaster.tgz "$HOST:/tmp/edumaster.tgz"
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
mkdir -p $APP/data
cd $APP
# Stopped while the files and node_modules are replaced: a job's verification worker loads mathjs from node_modules
# at each check, and KaTeX is served from there; unfinished jobs are marked interrupted on the next start and can be
# resumed. Whatever happens below, the service is started again.
systemctl --user stop edumaster 2>/dev/null || true
trap 'systemctl --user start edumaster 2>/dev/null || true' EXIT
# Only eval/reports keeps a copy the server made newer (a report made or rechecked there); everything else is replaced,
# so a lock file or page touched on the server cannot pin an old version.
tar xzf /tmp/edumaster.tgz --exclude=eval/reports
tar xzf /tmp/edumaster.tgz --keep-newer-files eval/reports 2>/dev/null || true
rm /tmp/edumaster.tgz
npm ci --omit=dev --no-audit --no-fund --loglevel=error
mkdir -p ~/.config/systemd/user
cp deploy/edumaster.service ~/.config/systemd/user/edumaster.service
systemctl --user daemon-reload
systemctl --user enable edumaster >/dev/null 2>&1
systemctl --user restart edumaster
sleep 2
systemctl --user is-active edumaster
curl -s http://127.0.0.1:18290/api/status
REMOTE
