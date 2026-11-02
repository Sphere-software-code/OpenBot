#!/usr/bin/env bash
#
# Start the stack again when its API server, routine worker or app has stopped without `stop.sh`.
#
# Nothing else supervises those three. `start.sh` leaves them running in the background of the
# shell that ran it, in that shell's session, so killing that session takes them with it, and they
# stay down until somebody runs `start.sh` by hand. A routine whose firing finds them down is dropped
# once it is ten minutes late (`DEFAULT_GRACE_MS` in server/src/routines/sweep.ts), so a stack that
# stopped at noon and was restarted at one has missed its 12:30 routine without a word anywhere.
#
# Run from root's crontab, every two minutes and once at boot:
#
#   */2 * * * * /root/OpenBot/scripts/watchdog.sh >> /root/OpenBot/.logs/watchdog.log 2>&1
#   @reboot sleep 60 && /root/OpenBot/scripts/watchdog.sh >> /root/OpenBot/.logs/watchdog.log 2>&1
#
# A miss is checked again a minute later before anything is started: `stop.sh && start.sh` by hand
# has the server down for a few seconds, and that is not this script's business. Nor is a stack a
# start.sh is still bringing up, which it names in `.logs/start.pid` while it runs. `stop.sh` leaves
# `.logs/watchdog.hold` behind so a stopped stack stays stopped, and `start.sh` removes it.
#
# `--check` says what is down, one name a line, and starts nothing: exit 0 when all three answer.

. "$(dirname "$0")/require-bash.sh"
. "$(dirname "$0")/processes.sh"

set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
LOGS="$ROOT/.logs"
mkdir -p "$LOGS"
# Appended, not replaced: cron's PATH has no bun, and a PATH that already has one keeps its own.
export PATH="$PATH:$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# The environment first, then .env, then the default, as start.sh and stop.sh resolve them.
setting() {
  local name="$1" fallback="$2" value="${!1:-}"
  if [ -z "$value" ] && [ -f "$ROOT/.env" ]; then
    value="$(grep -E "^$name=" "$ROOT/.env" | tail -1 | cut -d= -f2- | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true)"
  fi
  printf '%s' "${value:-$fallback}"
}

SERVER_PORT="$(setting SERVER_PORT 3001)"
APP_PORT="$(setting APP_PORT 3010)"

# Any HTTP answer counts. A slow licence check or a sign-in redirect is a process that is up, and
# start.sh would refuse a port held by one that answers as something else anyway.
answers() {
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true)" != "000" ]
}

down() {
  answers "http://localhost:$SERVER_PORT/api/copilotkit/info" || echo server
  running "bun worker/src/index.ts" || echo worker
  answers "http://localhost:$APP_PORT/" || echo app
}

# A start.sh still running, by hand or from an earlier run of this script, is already bringing the
# stack up, and an image build or a migration can keep it going past the minute below. Its process
# is asked for, not just its number: one killed outright leaves `start.pid` behind, and by now that
# number may be some other process's.
starting() {
  local pid
  pid="$(cat "$LOGS/start.pid" 2>/dev/null)" || return 1
  [ -n "$pid" ] && ps -o args= -p "$pid" 2>/dev/null | grep -q 'start\.sh'
}

if [ "${1:-}" = "--check" ]; then
  missing="$(down)"
  [ -n "$missing" ] && printf '%s\n' "$missing" && exit 1
  exit 0
fi

[ -e "$LOGS/watchdog.hold" ] && exit 0
[ -z "$(down)" ] && exit 0
sleep 60
[ -e "$LOGS/watchdog.hold" ] && exit 0
starting && exit 0
missing="$(down)"
[ -z "$missing" ] && exit 0

exec 9>"$LOGS/watchdog.lock"
flock -n 9 || exit 0
echo "$(date -u +%FT%TZ) down: $(printf '%s' "$missing" | tr '\n' ' ')- running start.sh"
# `9>&-`: what start.sh leaves running must not inherit the lock. A server that outlives this run
# would hold it for as long as it is up, and every later run would find it taken and start nothing.
setsid --wait bash scripts/start.sh </dev/null 9>&-
echo "$(date -u +%FT%TZ) start.sh exited $?"
