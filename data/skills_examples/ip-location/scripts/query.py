#!/usr/bin/env python3
import argparse
import ipaddress
import json
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request


ENDPOINT = "https://ipinfo.io"
OUTPUT_FIELDS = ("ip", "city", "region", "country", "loc", "org", "postal", "timezone")


def configure_stdio():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def print_json(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))


def print_error(data):
    print(json.dumps(data, ensure_ascii=False, indent=2), file=sys.stderr)


def positive_int(value):
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def public_ip(value):
    try:
        address = ipaddress.ip_address(value.strip())
    except ValueError as error:
        raise ValueError("--ip must be a valid IPv4 or IPv6 address") from error
    if not address.is_global:
        raise ValueError("--ip must be a public IPv4 or IPv6 address")
    return str(address)


def parse_args():
    parser = argparse.ArgumentParser(description="Look up a public IP and its approximate network location via IPinfo.")
    parser.add_argument("--ip", help="Public IPv4 or IPv6 address; omit for the current network.")
    parser.add_argument("--timeout", type=positive_int, default=30, help="HTTP timeout in seconds.")
    return parser.parse_args()


def request_location(ip, timeout):
    path = "/json" if ip is None else "/{}/json".format(urllib.parse.quote(ip, safe=""))
    request = urllib.request.Request(
        ENDPOINT + path,
        headers={
            "User-Agent": "ip-location Agent Skill",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
        data = json.loads(body)
        if not isinstance(data, dict):
            raise ValueError("IPinfo returned a non-object JSON response.")
        if data.get("error"):
            error = data["error"]
            if isinstance(error, dict):
                error = error.get("message") or error.get("title") or error
            raise ValueError("IPinfo returned an error: {}".format(error))
        if not isinstance(data.get("ip"), str) or not data["ip"].strip():
            raise ValueError("IPinfo response did not include an IP address.")
        return response.status, data


def main():
    configure_stdio()
    args = parse_args()
    try:
        ip = public_ip(args.ip) if args.ip is not None else None
        status, response = request_location(ip, args.timeout)
        data = {
            field: value if isinstance((value := response.get(field)), str) and value else None
            for field in OUTPUT_FIELDS
        }
        print_json({"ok": True, "status": status, "data": data})
        return 0
    except urllib.error.HTTPError as error:
        print_error({
            "ok": False,
            "status": error.code,
            "error": "IPinfo returned HTTP {}.".format(error.code),
        })
        return 1
    except urllib.error.URLError as error:
        timed_out = isinstance(error.reason, (TimeoutError, socket.timeout))
        print_error({
            "ok": False,
            "error": "The IPinfo request timed out." if timed_out else "Failed to reach IPinfo: {}".format(error.reason),
            "error_type": "TimeoutError" if timed_out else type(error.reason).__name__,
        })
        return 1
    except TimeoutError:
        print_error({"ok": False, "error": "The IPinfo request timed out.", "error_type": "TimeoutError"})
        return 1
    except (json.JSONDecodeError, ValueError) as error:
        print_error({"ok": False, "error": str(error)})
        return 2 if str(error).startswith("--ip") else 1
    except Exception as error:
        print_error({"ok": False, "error": str(error), "error_type": type(error).__name__})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
