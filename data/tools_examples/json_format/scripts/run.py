import json
import sys


def main():
    args = json.loads(sys.argv[1])
    text = json.dumps(args["value"], ensure_ascii=False, indent=2, sort_keys=args.get("sort_keys", False), allow_nan=False)
    if len(text.encode("utf-8")) > 100000:
        raise ValueError("Formatted output exceeds 100000 UTF-8 bytes; no partial content was returned")
    sys.stdout.write(text)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
