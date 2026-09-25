---
name: ip-location
description: "Find a public IP address and its approximate network location via IPinfo. Use when the user asks for their current IP, city, region, country, timezone, network operator, coordinates, or when another task needs a rough location inferred from the current network. Do not use for precise device location or private and reserved addresses."
compatibility: "Requires Python 3.8+ and internet access to ipinfo.io."
---

# IP Location

Run `scripts/query.py` with Python 3.8+. Allow at least 45 seconds for the default HTTP timeout of 30 seconds; use `--timeout SECONDS` to change that timeout.

- Current network: run without arguments.
- Specific address: pass `--ip` and a public IPv4 or IPv6 address.

On success, read standard-output JSON and return only the requested fields inside `data`: `ip`, `city`, `region`, `country`, `loc`, `org`, `postal`, and `timezone`. A `null` field was not supplied by the service. Do not return raw JSON unless requested.

On failure, read the standard-error JSON and report `error` instead of guessing. Treat the location as approximate: VPNs, proxies, carrier gateways, and cloud egress may identify the exit network instead of the user's physical location.
