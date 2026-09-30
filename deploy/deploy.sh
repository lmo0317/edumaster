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
tar xzf /tmp/edumaster.tgz --keep-newer-files --warning=no-ignore-newer && rm /tmp/edumaster.tgz
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
