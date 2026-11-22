#!/usr/bin/env bash
# Install or back out the paperclip rail-board systemd timer.
#
# Run as root. Q&R PASS is the approval to run `install`.
#   ./install.sh            install / upgrade (backup + read-back)
#   ./install.sh --backout  remove the timer and restore the previous units
#   ./install.sh --dry      print the plan, change nothing
#
# Permissions: the script creates the state and publish dirs owned by
# paperclip. Confirm with Russell before the first install if /srv/estate
# uses a group layout.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="/etc/systemd/system"
BACKUP_ROOT="/var/backups/uclh-rail"
CONFIG_DIR="/etc/uclh-rail"
CONFIG="$CONFIG_DIR/config.json"
STATE_DIR="/var/lib/uclh-rail"
PUBLISH_DIR="/srv/estate/publish/rail"
UNITS=(rail-board.service rail-board.timer)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

MODE=install
case "${1:-}" in
  --backout) MODE=backout ;;
  --dry) MODE=dry ;;
  "") ;;
  *) echo "usage: $0 [--backout|--dry]" >&2; exit 2 ;;
esac

if [ "$(id -u)" != "0" ] && [ "$MODE" != "dry" ]; then
  echo "must run as root (or use --dry)" >&2
  exit 1
fi

backup_units() {
  mkdir -p "$BACKUP_ROOT/$STAMP"
  for u in "${UNITS[@]}"; do
    if [ -f "$UNIT_DIR/$u" ]; then
      cp -a "$UNIT_DIR/$u" "$BACKUP_ROOT/$STAMP/$u"
    fi
  done
  printf '%s\n' "$STAMP" > "$BACKUP_ROOT/latest"
}

do_install() {
  if [ "$MODE" = "dry" ]; then
    echo "DRY: would install ${UNITS[*]} into $UNIT_DIR, create $STATE_DIR and $PUBLISH_DIR,"
    echo "DRY: create $CONFIG from config.example.json if missing, and enable rail-board.timer"
    return
  fi

  if [ ! -f "$CONFIG" ]; then
    install -d -m 0750 "$CONFIG_DIR"
    install -m 0600 "$REPO_DIR/config.example.json" "$CONFIG"
    echo "created $CONFIG from the example - edit the number, off dates and token before it alerts"
  fi

  install -d -m 0750 -o paperclip -g paperclip "$STATE_DIR"
  install -d -m 0755 -o paperclip -g paperclip "$PUBLISH_DIR"

  backup_units
  for u in "${UNITS[@]}"; do
    install -m 0644 "$REPO_DIR/systemd/$u" "$UNIT_DIR/$u"
  done

  systemctl daemon-reload
  systemctl enable --now rail-board.timer

  echo "--- read-back ---"
  printf 'enabled: %s\n' "$(systemctl is-enabled rail-board.timer)"
  printf 'active:  %s\n' "$(systemctl is-active rail-board.timer)"
  systemctl list-timers rail-board.timer --no-pager
}

do_backout() {
  if [ "$MODE" = "dry" ]; then
    echo "DRY: would disable rail-board.timer, remove ${UNITS[*]}, and restore the last backup"
    return
  fi
  systemctl disable --now rail-board.timer 2>/dev/null || true
  for u in "${UNITS[@]}"; do
    rm -f "$UNIT_DIR/$u"
  done
  if [ -f "$BACKUP_ROOT/latest" ]; then
    prev="$BACKUP_ROOT/$(cat "$BACKUP_ROOT/latest")"
    for u in "${UNITS[@]}"; do
      if [ -f "$prev/$u" ]; then
        cp -a "$prev/$u" "$UNIT_DIR/$u"
      fi
    done
  fi
  systemctl daemon-reload
  if [ -f "$UNIT_DIR/rail-board.timer" ]; then
    systemctl enable --now rail-board.timer
  fi
  echo "backout done. Data kept in $STATE_DIR and $PUBLISH_DIR."
}

case "$MODE" in
  backout) do_backout ;;
  *) do_install ;;
esac
