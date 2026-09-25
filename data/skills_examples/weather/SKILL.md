---
name: weather
description: "Get current weather and forecasts for a location via wttr.in. Use for temperature, rain, wind, humidity, and today, tomorrow, or multi-day forecasts. Do not use for historical weather, severe alerts, aviation or marine reports, or specialist meteorology."
compatibility: "Requires Python 3 and internet access to wttr.in."
---

# Weather

Run `scripts/query.py` with Python 3 and allow at least 45 seconds. Pass a known city, region, or airport code with `--location`. Omit `--location` for "here" or the current location; wttr.in will infer an approximate location from the network address.

Choose `--view` from:

- `summary` (default): concise current conditions
- `rain`: precipitation summary
- `current`: current conditions only
- `today`: current conditions and today's forecast
- `tomorrow`: forecast through tomorrow; answer only for the requested day
- `day-after`: three-day forecast; answer only for the day after tomorrow
- `forecast`: forecast from today through the day after tomorrow
- `json`: structured data when exact fields or calculations are needed

Parse successful standard output and answer only what the user asked. On failure, read the standard-error JSON and report `error`. Do not return raw JSON unless requested.

Avoid repeated requests for the same location and view because wttr.in is rate limited. If the service fails, report the error instead of guessing.
