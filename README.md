# railwatch

Live Hemel Hempstead <-> London Euston board and alerts (TEC-427). Data: National Rail via Rail Data Marketplace.

## What runs

`rail-board.timer` fires `rail-board.service` every 2 minutes. The service runs
the **root-owned copy at `/opt/uclh/railwatch`**, not the agent-writable
checkout: it needs root for the SSH hop to caddy and to read
`/etc/uclh-rail/config.json`. The drop-in
`systemd/rail-board.service.d/root-copy.conf` sets `User=root` and
`ExecStart=/opt/uclh/railwatch/rail/run.mjs`. The runner
(`rail/run.mjs`) does the real gating, so the timer itself is dumb:

| Gate | Rule |
| --- | --- |
| window | weekdays 07:00-09:00 HML→EUS, 17:00-19:00 EUS→HML (Europe/London), half-open |
| weekend | no poll |
| bank holiday | no poll (gov.uk `england-and-wales`, cached daily) |
| off date | no poll (`off:` in `/etc/uclh-rail/config.json`) |

Inside a window it makes one call per direction, publishes the latest board per
direction, and sends each new alert once.

### Alert rules

The rules live in `rail/alerts.mjs` (TEC-430). Each alert is sent once per
`serviceId|kind|value`; the sent keys are kept in the state file and pruned to
the services on the current board.

| Alert | When |
| --- | --- |
| Cancelled | a service is cancelled |
| Late | expected departure is 5 or more minutes after the scheduled time, or the estimate is `Delayed` with no time |
| Platform change | the platform changes within 10 minutes of departure |
| On time again | a train that was alerted late is `On time` again |

## Files

| Path | Purpose |
| --- | --- |
| `rail/ldbws.mjs` | LDBWS client (`x-apikey`, RDM base URL) |
| `rail/alerts.mjs` | alert rules + per-change dedupe |
| `rail/run.mjs` | window/date gates, fetch, publish, notify, state |
| `rail/holidays.mjs` | gov.uk bank holidays, daily cache, stale fallback |
| `rail/notify.mjs` | caddy `/api/whatsapp/notify` (same route as `snow-freshness`) |
| `systemd/` | `rail-board.service`, `rail-board.timer`, `rail-board.service.d/root-copy.conf` |
| `install.sh` | copy to `/opt/uclh/railwatch`, install units + drop-in, `--backout` (root) |

## Config and secrets

- `/etc/uclh-rail/ldbws.env` (root 600): `LDBWS_URL`, `LDBWS_KEY`. Never logged or committed.
- `/etc/uclh-rail/config.json` (root 600, from `config.example.json`): WhatsApp number,
  `off:` dates, publish/state dirs, caddy notify settings. Never committed.
- State (`/var/lib/uclh-rail/alerts.json`, plus the `bank-holidays.json` cache)
  and published output (`/srv/estate/publish/rail/board.json`) are never committed.

## Run it

```sh
node rail/run.mjs --dry   # gate check + print, no send
node --test               # all rules, no network
```

`--dry` only suppresses the WhatsApp send. Inside an open window it still
fetches from LDBWS and writes the publish/state files, so it is not a full
offline mode. Transient LDBWS failures (429/5xx) set a cooldown in the state
file (2, 4, 8, 10 minutes) so the 2-minute timer does not hammer the API.

## Stop it

```sh
sudo systemctl disable --now rail-board.timer
```

This stops the timer and stops it from starting again at boot. The service is
`Type=oneshot`, so there is no long-running process to kill and an in-flight run
finishes. To pause only, stop the timer and start it again later; to remove the
units and drop-in completely, run `sudo ./install.sh --backout` (see below).

## Install and upgrade

`sudo ./install.sh`:

1. copies this tree (minus `.git`) to `/opt/uclh/railwatch`, owned by root;
2. creates `/var/lib/uclh-rail` and `/srv/estate/publish/rail` (owned by `paperclip`);
3. creates `/etc/uclh-rail/config.json` from the example if missing;
4. backs up the current units, then installs `rail-board.service`, `rail-board.timer`
   and the `rail-board.service.d/root-copy.conf` drop-in;
5. reloads systemd, enables the timer, and prints a read-back (`is-enabled`,
   `is-active`, the effective `User`/`ExecStart`, `list-timers`).

**Upgrade** = run `sudo ./install.sh` again from the checkout after `main` moves;
it re-copies the tree and reinstalls the units. Running it from `/opt/uclh/railwatch`
itself skips the copy step.

`sudo ./install.sh --backout` disables and removes the timer, the unit files and the
drop-in, then restores the last backup of each. It leaves `/opt/uclh/railwatch`,
the state dir and the publish dir in place.

`sudo ./install.sh --dry` prints the plan and changes nothing.
Q&R PASS is the approval to install.
