# Home Assistant rail board (TEC-432)

Shows the HML ↔ EUS board on a Home Assistant dashboard. It reads the file
rail 3 publishes:

    /srv/estate/publish/rail/board.json

on paperclip. Home Assistant is a different host (CT111), so that file must be
exposed to it. Two ways work; pick one and tell Rail which, so the card can be
installed and read back.

## Feed contract

`/srv/estate/publish/rail/board.json`:

```json
{
  "generatedAt": "2026-11-23T07:04:00Z",
  "boards": [
    {
      "from": "HML", "fromName": "Hemel Hempstead",
      "to": "EUS", "toName": "London Euston",
      "generatedAt": "2026-11-23T07:04:00Z",
      "services": [
        { "id": "HML-EUS-0712", "std": "07:12", "etd": "On time",
          "platform": "1", "cancelled": false, "delayReason": null,
          "operator": "London Northwestern Railway" }
      ]
    },
    { "from": "EUS", "...": "second direction" }
  ]
}
```

`rail/board.mjs` validates and formats this; `rail/board.test.mjs` runs it
against `rail/fixtures/board.json`.

## Install

1. Copy `homeassistant/packages/rail_board.yaml` into HA's `packages/`
   directory and include packages from `configuration.yaml`.
2. Add one secret to HA's `secrets.yaml`, pointing at wherever the file is
   exposed:
   - Option A (HTTP): the caddy route or static URL that serves
     `folder/board.json`, e.g. `http://caddy:8080/rail/board.json`.
   - Option B (shared folder): if the estate folder is mounted on HA, point a
     small local static server at `/srv/estate/publish/rail/`, or use HA's
     `command_line` sensor to `cat` the file. Ask Rail to adjust the package if
     Option B is chosen.
   `rail_board_url: "..."`.
3. Restart HA, confirm `sensor.rail_board` shows a `generatedAt`, then add
   `homeassistant/rail-board-card.yaml` as a Manual card.

## Why the card needs the URL

The browser cannot read a file on the HA host, and a cross-origin fetch needs
CORS. The `rest` sensor reads the feed on the server side, so the card stays a
plain markdown card with no new dependency.
