#!/usr/bin/env python3
import argparse
import json
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request


VIEWS = {
    "summary": "?format={}".format(urllib.parse.quote_plus("%l: %c %t (feels like %f), %w wind, %h humidity")),
    "rain": "?format={}".format(urllib.parse.quote_plus("%l: %c %p")),
    "current": "?0T",
    "today": "?1T",
    "tomorrow": "?2T",
    "day-after": "?T",
    "forecast": "?T",
    "json": "?format=j1",
}


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def print_error(error: str, **details: object) -> None:
    print(json.dumps({"ok": False, "error": error, **details}, ensure_ascii=False), file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Get current weather and forecasts via wttr.in.")
    parser.add_argument("--location", default="", help="City, region, or airport code; omit for the current network.")
    parser.add_argument(
        "--view",
        choices=sorted(VIEWS),
        default="summary",
        help="Weather view to request.",
    )
    return parser.parse_args()


def main() -> int:
    configure_stdio()
    args = parse_args()
    location = args.location.strip()
    encoded_location = urllib.parse.quote_plus(location)
    url = "https://wttr.in/{}{}".format(encoded_location, VIEWS[args.view])
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "curl/8.0 weather-skill",
            "Accept": "text/plain, application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as error:
        target = location or "the current network"
        print_error("wttr.in returned HTTP {} for {}".format(error.code, target), status=error.code)
        return 1
    except urllib.error.URLError as error:
        timed_out = isinstance(error.reason, (TimeoutError, socket.timeout))
        print_error(
            "The wttr.in request timed out." if timed_out else "Failed to reach wttr.in: {}".format(error.reason),
            error_type="TimeoutError" if timed_out else type(error.reason).__name__,
        )
        return 1
    except TimeoutError:
        print_error("The wttr.in request timed out.", error_type="TimeoutError")
        return 1

    if not body.strip():
        print_error("wttr.in returned an empty response.")
        return 1

    sys.stdout.write(body)
    if body and not body.endswith("\n"):
        sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
