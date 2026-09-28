#!/bin/bash
set -eu
WORK=/home/lmo0317/apps/edumaster/feedback-verification
TEST=$WORK/v2-api
PID=$(cat "$TEST/pid.txt")
if [ "$(readlink /proc/$PID/cwd)" != "$TEST" ]; then exit 1; fi
kill "$PID"
sleep 1
cp "$WORK/EduMaster.Core.dll" "$TEST/EduMaster.Core.dll"
cp "$WORK/EduMaster.Web.dll" "$TEST/EduMaster.Web.dll"
cd "$TEST"
nohup env EDUMASTER_LISTEN_URL=http://127.0.0.1:18289 EDUMASTER_FEEDBACK_TRACE_DIRECTORY="$TEST/feedback-trace" ./EduMaster.Web >server.log 2>&1 </dev/null &
echo $! >pid.txt
