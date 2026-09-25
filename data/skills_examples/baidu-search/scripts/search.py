#!/usr/bin/env python3
import argparse
import json
import os
import socket
import sys
import urllib.error
import urllib.request


ENDPOINT = "https://qianfan.baidubce.com/v2/ai_search/web_search"
API_KEY_ENV = "BAIDU_SEARCH_API_KEY"


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


def query_length(value):
    return len(value.encode("gb18030"))


def request_search(query, api_key, timeout):
    payload = json.dumps({
        "messages": [
            {
                "role": "user",
                "content": query,
            }
        ],
        "search_source": "baidu_search_v2",
    }).encode("utf-8")
    request = urllib.request.Request(
        ENDPOINT,
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(body)
        except json.JSONDecodeError as error:
            raise RuntimeError("Baidu AI Search returned invalid JSON.") from error
        if not isinstance(data, dict):
            raise RuntimeError("Baidu AI Search returned a non-object JSON response.")
        return response.status, data


def parse_args():
    parser = argparse.ArgumentParser(description="Search real-time information with Baidu AI Search.")
    parser.add_argument("--query", required=True, help="Complete search query.")
    parser.add_argument("--timeout", type=positive_int, default=30, help="HTTP timeout in seconds.")
    return parser.parse_args()


def main():
    configure_stdio()
    args = parse_args()
    query = args.query.strip()
    if not query:
        print_error({"ok": False, "error": "--query must not be empty."})
        return 2
    if query_length(query) > 72:
        print_error({
            "ok": False,
            "error": "--query exceeds Baidu AI Search's 72-character limit (Chinese characters count as two).",
            "next_step": "Shorten the query while preserving its key name, date, location, and constraints.",
        })
        return 2

    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not api_key:
        print_error({
            "ok": False,
            "error": f"Missing environment variable: {API_KEY_ENV}.",
            "next_step": f"Configure {API_KEY_ENV} for the baidu-search skill.",
        })
        return 2

    try:
        status, data = request_search(query, api_key, args.timeout)
        error_code = data.get("code")
        if error_code not in (None, "", 0, "0"):
            print_error({
                "ok": False,
                "query": query,
                "status": status,
                "code": error_code,
                "error": str(data.get("message") or "Baidu AI Search returned an error."),
                **({"request_id": data["request_id"]} if data.get("request_id") else {}),
            })
            return 1
        print_json({
            "ok": True,
            "query": query,
            "status": status,
            "data": data,
        })
        return 0
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            data = body
        print_error({
            "ok": False,
            "query": query,
            "status": exc.code,
            "error": str(exc.reason),
            "data": data,
        })
        return 1
    except urllib.error.URLError as exc:
        timed_out = isinstance(exc.reason, (TimeoutError, socket.timeout))
        print_error({
            "ok": False,
            "query": query,
            "error": "Request timed out." if timed_out else str(exc.reason),
            "error_type": "TimeoutError" if timed_out else type(exc.reason).__name__,
        })
        return 1
    except TimeoutError:
        print_error({
            "ok": False,
            "query": query,
            "error": "Request timed out.",
            "error_type": "TimeoutError",
        })
        return 1
    except Exception as exc:
        print_error({
            "ok": False,
            "query": query,
            "error": str(exc),
            "error_type": type(exc).__name__,
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
