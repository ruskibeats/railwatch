#!/usr/bin/env bash
# Install or back out the paperclip rail-board systemd timer.
#
# Run as root. Q&R PASS is the approval to run `install`.
#   ./install.sh            install / upgrade (backup + read-back)
#   ./install.sh --backout  remove the timer and restore the previous units
#   ./install.sh --dry      print the plan, change nothing
#
# Runtime: the service does not run from this checkout. install copies the tree
# HEAD (git archive) to RUNTIME_DIR (/opt/uclh/railwatch, root-owned) and the
# unit runs it as root. Re-run install to upgrade.
# Permissions: the state and publish dirs are root-owned, because the service
# writes them as root and an agent-owned dir would let paperclip symlink those
# writes onto any file. Confirm with Russell before the first install if
# /srv/estate uses a group layout.
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
# Left behind by the PR #7 installer; superseded by User=root in the unit.
OLD_DROPIN="$UNIT_DIR/rail-board.service.d/root-copy.conf"
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

# Back up once, before the first install, so --backout restores the pre-railwatch
# units. Backing up on every run would make backout restore our own units.
backup_units() {
  [ -f "$BACKUP_ROOT/latest" ] && return
  mkdir -p "$BACKUP_ROOT/$STAMP"
  for f in "${UNITS[@]}"; do
    if [ -f "$UNIT_DIR/$f" ]; then
      cp -a "$UNIT_DIR/$f" "$BACKUP_ROOT/$STAMP/$f"
    fi
  done
  printf '%s\n' "$STAMP" > "$BACKUP_ROOT/latest"
}

remove_old_dropin() {
  rm -f "$OLD_DROPIN"
  rmdir "$(dirname "$OLD_DROPIN")" 2>/dev/null || true
}

do_install() {
  if [ "$MODE" = "dry" ]; then
    echo "DRY: would replace $RUNTIME_DIR with git HEAD (root-owned) unless already running from there"
    echo "DRY: would install ${UNITS[*]} into $UNIT_DIR, create root-owned $STATE_DIR and $PUBLISH_DIR,"
    echo "DRY: create $CONFIG from config.example.json if missing, and enable rail-board.timer"
    return
  fi

  if [ ! -f "$CONFIG" ]; then
    install -d -m 0750 "$CONFIG_DIR"
    install -m 0600 "$REPO_DIR/config.example.json" "$CONFIG"
    echo "created $CONFIG from the example - edit the number, off dates and token before it alerts"
  fi

  install -d -m 0750 -o root -g root "$STATE_DIR"
  install -d -m 0755 -o root -g root "$PUBLISH_DIR"
  chown -R root:root "$STATE_DIR" "$PUBLISH_DIR"

  if [ "$REPO_DIR" != "$RUNTIME_DIR" ]; then
    # Committed files only: no ignored secrets, no stale files, root-owned 0644/0755.
    # Archive first so a git failure leaves the old runtime untouched.
    # safe.directory: root running git in the paperclip-owned checkout.
    install -d -m 0700 "$BACKUP_ROOT"
    git -c safe.directory="$REPO_DIR" -C "$REPO_DIR" archive -o "$BACKUP_ROOT/runtime.tar" HEAD
    rm -rf "$RUNTIME_DIR"
    install -d -m 0755 "$RUNTIME_DIR"
    tar -C "$RUNTIME_DIR" --no-same-owner -xf "$BACKUP_ROOT/runtime.tar"
    echo "copied $REPO_DIR HEAD -> $RUNTIME_DIR"
  fi

  backup_units
  remove_old_dropin
  for f in "${UNITS[@]}"; do
    # From the committed copy, so the units match the code that runs.
    install -m 0644 "$RUNTIME_DIR/systemd/$f" "$UNIT_DIR/$f"
  done

  systemctl daemon-reload
  systemctl enable --now rail-board.timer

  echo "--- read-back ---"
  printf 'enabled: %s\n' "$(systemctl is-enabled rail-board.timer)"
  printf 'active:  %s\n' "$(systemctl is-active rail-board.timer)"
  printf 'effective:\n'
  systemctl show -p User -p ExecStart rail-board.service
  systemctl list-timers rail-board.timer --no-pager
}

do_backout() {
  if [ "$MODE" = "dry" ]; then
    echo "DRY: would disable rail-board.timer, remove ${UNITS[*]}, and restore the pre-install backup"
    echo "DRY: leaves $RUNTIME_DIR, $STATE_DIR and $PUBLISH_DIR in place"
    return
  fi
  systemctl disable --now rail-board.timer 2>/dev/null || true
  for f in "${UNITS[@]}"; do
    rm -f "$UNIT_DIR/$f"
  done
  remove_old_dropin
  if [ -f "$BACKUP_ROOT/latest" ]; then
    prev="$BACKUP_ROOT/$(cat "$BACKUP_ROOT/latest")"
    for f in "${UNITS[@]}"; do
      if [ -f "$prev/$f" ]; then
        install -m 0644 "$prev/$f" "$UNIT_DIR/$f"
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
