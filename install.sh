#!/usr/bin/env bash
# Install or back out the paperclip rail-board systemd timer.
#
# Run as root. Q&R PASS is the approval to run `install`.
#   ./install.sh            install / upgrade (backup + read-back)
#   ./install.sh --backout  remove the timer and restore the previous units
#   ./install.sh --dry      print the plan, change nothing
#
# Runtime: the service does not run from this checkout. install copies the tree
# to RUNTIME_DIR (/opt/uclh/railwatch, root-owned) and installs the drop-in
# systemd/rail-board.service.d/root-copy.conf, so the unit runs as root with
# ExecStart=/opt/uclh/railwatch/rail/run.mjs. Re-run install to upgrade.
# Permissions: the script creates the state and publish dirs owned by
# paperclip. Confirm with Russell before the first install if /srv/estate
# uses a group layout.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="/opt/uclh/railwatch"
UNIT_DIR="/etc/systemd/system"
BACKUP_ROOT="/var/backups/uclh-rail"
CONFIG_DIR="/etc/uclh-rail"
CONFIG="$CONFIG_DIR/config.json"
STATE_DIR="/var/lib/uclh-rail"
PUBLISH_DIR="/srv/estate/publish/rail"
UNITS=(rail-board.service rail-board.timer)
FILES=(rail-board.service rail-board.timer rail-board.service.d/root-copy.conf)
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
  for f in "${FILES[@]}"; do
    if [ -f "$UNIT_DIR/$f" ]; then
      mkdir -p "$BACKUP_ROOT/$STAMP/$(dirname "$f")"
      cp -a "$UNIT_DIR/$f" "$BACKUP_ROOT/$STAMP/$f"
    fi
  done
  printf '%s\n' "$STAMP" > "$BACKUP_ROOT/latest"
}

do_install() {
  if [ "$MODE" = "dry" ]; then
    echo "DRY: would copy the tree to $RUNTIME_DIR (root-owned) unless already running from there"
    echo "DRY: would install ${FILES[*]} into $UNIT_DIR, create $STATE_DIR and $PUBLISH_DIR,"
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

  if [ "$REPO_DIR" != "$RUNTIME_DIR" ]; then
    install -d -m 0755 "$RUNTIME_DIR"
    tar -C "$REPO_DIR" --exclude=./.git -cf - . | tar -C "$RUNTIME_DIR" -xf -
    chown -R root:root "$RUNTIME_DIR"
    echo "copied $REPO_DIR -> $RUNTIME_DIR"
  fi

  backup_units
  for f in "${FILES[@]}"; do
    install -D -m 0644 "$REPO_DIR/systemd/$f" "$UNIT_DIR/$f"
  done

  systemctl daemon-reload
  systemctl enable --now rail-board.timer

  echo "--- read-back ---"
  printf 'enabled: %s\n' "$(systemctl is-enabled rail-board.timer)"
  printf 'active:  %s\n' "$(systemctl is-active rail-board.timer)"
  printf 'effective:\n'
  systemctl cat rail-board.service --no-pager | grep -E '^(User|ExecStart)='
  systemctl list-timers rail-board.timer --no-pager
}

do_backout() {
  if [ "$MODE" = "dry" ]; then
    echo "DRY: would disable rail-board.timer, remove ${FILES[*]}, and restore the last backup"
    echo "DRY: leaves $RUNTIME_DIR, $STATE_DIR and $PUBLISH_DIR in place"
    return
  fi
  systemctl disable --now rail-board.timer 2>/dev/null || true
  for f in "${FILES[@]}"; do
    rm -f "$UNIT_DIR/$f"
  done
  rmdir "$UNIT_DIR/rail-board.service.d" 2>/dev/null || true
  if [ -f "$BACKUP_ROOT/latest" ]; then
    prev="$BACKUP_ROOT/$(cat "$BACKUP_ROOT/latest")"
    for f in "${FILES[@]}"; do
      if [ -f "$prev/$f" ]; then
        install -D -m 0644 "$prev/$f" "$UNIT_DIR/$f"
      fi
    done
  fi
  systemctl daemon-reload
  if [ -f "$UNIT_DIR/rail-board.timer" ]; then
    systemctl enable --now rail-board.timer
  fi
  echo "backout done. Data kept in $RUNTIME_DIR (unused), $STATE_DIR and $PUBLISH_DIR."
}

case "$MODE" in
  backout) do_backout ;;
  *) do_install ;;
esac
