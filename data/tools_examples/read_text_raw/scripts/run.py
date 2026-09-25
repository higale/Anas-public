import json
from pathlib import Path
import sys

MAX_BYTES = 512 * 1024


def main():
    path = Path(json.loads(sys.argv[1])["path"])
    if not path.is_absolute() or not path.is_file():
        raise ValueError("path must be an absolute path to a regular file")
    with path.open("rb") as stream:
        content = stream.read(MAX_BYTES + 1)
    if len(content) > MAX_BYTES:
        raise ValueError("File exceeds 512 KiB (524288 bytes); no partial content was returned")
    content.decode("utf-8")
    sys.stdout.buffer.write(content)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
