import hashlib
import json
from pathlib import Path
import sys


def main():
    path = Path(json.loads(sys.argv[1])["path"])
    if not path.is_absolute() or not path.is_file():
        raise ValueError("path must be an absolute path to a regular file")
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
            size += len(block)
    print(json.dumps({"path": str(path), "bytes": size, "sha256": digest.hexdigest()}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
