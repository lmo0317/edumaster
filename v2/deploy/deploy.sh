#!/usr/bin/env bash
# Deploys v2 to the 112 server (run from Git Bash on the dev PC). Keeps the server's data/ folder.
set -euo pipefail
HOST=lmo0317@192.168.219.112
APP=/home/lmo0317/apps/edumasterv2
cd "$(dirname "$0")/.."
tar czf /tmp/edumasterv2.tgz --exclude=node_modules --exclude=data --exclude=data-mock --exclude=test --exclude=eval/.work --exclude=eval/reports package.json package-lock.json server public deploy scripts eval
scp -q /tmp/edumasterv2.tgz "$HOST:/tmp/edumasterv2.tgz"
ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
mkdir -p $APP/data
cd $APP
tar xzf /tmp/edumasterv2.tgz && rm /tmp/edumasterv2.tgz
npm ci --omit=dev --no-audit --no-fund --loglevel=error
# First deploy: reuse v1's DeepSeek key and access code so both versions open with the same code.
[ -s data/deepseek-api-key.txt ] || install -m 600 /home/lmo0317/apps/edumaster/backend/deepseek-api-key.txt data/deepseek-api-key.txt
[ -s data/access-code.txt ] || install -m 600 /home/lmo0317/apps/edumaster/backend/access-token.txt data/access-code.txt
mkdir -p ~/.config/systemd/user
cp deploy/edumaster-v2.service ~/.config/systemd/user/edumaster-v2.service
systemctl --user daemon-reload
systemctl --user enable edumaster-v2 >/dev/null 2>&1
systemctl --user restart edumaster-v2
sleep 2
systemctl --user is-active edumaster-v2
curl -s http://127.0.0.1:18290/api/status
REMOTE
