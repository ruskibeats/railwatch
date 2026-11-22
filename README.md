# railwatch

Live Hemel Hempstead <-> London Euston board and alerts (TEC-427). Data: National Rail via Rail Data Marketplace.

## What runs

`rail-board.timer` fires `rail-board.service` every 2 minutes. The runner
(`rail/run.mjs`) does the real gating, so the timer itself is dumb:

| Gate | Rule |
| --- | --- |
| window | weekdays 07:00-09:00 HML→EUS, 17:00-19:00 EUS→HML (Europe/London), half-open |
| weekend | no poll |
| bank holiday | no poll (gov.uk `england-and-wales`, cached daily) |
| off date | no poll (`off:` in `/etc/uclh-rail/config.json`) |

Inside a window it makes one call per direction, publishes the latest board per
direction, and sends each new alert once (TEC-430 rules).

## Files

| Path | Purpose |
| --- | --- |
| `rail/ldbws.mjs` | LDBWS client (`x-apikey`, RDM base URL) |
| `rail/alerts.mjs` | alert rules + per-change dedupe |
| `rail/run.mjs` | window/date gates, fetch, publish, notify, state |
| `rail/holidays.mjs` | gov.uk bank holidays, daily cache, stale fallback |
| `rail/notify.mjs` | caddy `/api/whatsapp/notify` (same route as `snow-freshness`) |
| `systemd/` | `rail-board.service` + `rail-board.timer` |
| `install.sh` | install / upgrade / `--backout` (root) |

## Config and secrets

- `/etc/uclh-rail/ldbws.env` (root 600): `LDBWS_URL`, `LDBWS_KEY`. Never logged or committed.
- `/etc/uclh-rail/config.json` (root 600, from `config.example.json`): WhatsApp number,
  `off:` dates, publish/state dirs, caddy notify settings. Never committed.
- State (`/var/lib/uclh-rail`) and published output (`/srv/estate/publish/rail/board.json`)
  are never committed.

## Run it

```sh
node rail/run.mjs --dry   # gate check + print, no send
node --test               # all rules, no network
```

`--dry` only suppresses the WhatsApp send. Inside an open window it still
fetches from LDBWS and writes the publish/state files, so it is not a full
offline mode. Transient LDBWS failures (429/5xx) set a cooldown in the state
file (2, 4, 8, 10 minutes) so the 2-minute timer does not hammer the API.

## Install

`sudo ./install.sh` backs up any existing units, installs them, enables the timer,
and prints a read-back (`is-enabled`, `is-active`, `list-timers`).
`sudo ./install.sh --backout` disables and removes the timer and restores the backup.
Q&R PASS is the approval to install.
