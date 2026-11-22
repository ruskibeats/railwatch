# railwatch

Live Hemel Hempstead <-> London Euston board and alerts (TEC-427). Data: National Rail via Rail Data Marketplace.

Layout:

- `rail/ldbws.mjs` LDBWS client (Rail 1).
- `rail/alerts.mjs` alert rules (Rail 2).
- `rail/board.mjs` published board contract and card rows (Rail 4).
- `homeassistant/` Home Assistant package and card reading `board.json` (Rail 4).

Run the tests with `npm test`.
