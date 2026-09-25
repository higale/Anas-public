#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, List


DEFAULT_EXTENSIONS = {
    ".jpg",
    ".jpeg",
    ".png",
    ".heic",
    ".heif",
    ".tif",
    ".tiff",
    ".webp",
    ".avif",
    ".dng",
    ".cr2",
    ".cr3",
    ".nef",
    ".arw",
    ".rw2",
    ".orf",
    ".raf",
}

SEARCH_TAGS = [
    "Subject",
    "Keywords",
    "HierarchicalSubject",
    "Title",
    "ObjectName",
    "Description",
    "ImageDescription",
    "Caption-Abstract",
    "Comment",
    "PersonInImage",
    "RegionName",
]

DATE_KEYS = [
    "ExifIFD:DateTimeOriginal",
    "QuickTime:CreateDate",
    "XMP-xmp:CreateDate",
    "ExifIFD:CreateDate",
    "IFD0:ModifyDate",
    "XMP-xmp:ModifyDate",
    "System:FileModifyDate",
]

EXIFTOOL_INSTALL_HELP = """ExifTool not found.

Stop: do not try shell fallback discovery or alternate photo searches. Install ExifTool, add it to PATH, or pass --exiftool.

Install ExifTool and make sure `exiftool -ver` works.

Windows:
1. Open https://exiftool.org/
2. Download the Windows Executable.
3. Extract it, rename `exiftool(-k).exe` to `exiftool.exe`.
4. Put it in a fixed folder such as C:\\Tools\\exiftool and add that folder to PATH.

macOS with Homebrew:
  brew install exiftool

After installing, open a new terminal and run:
  exiftool -ver

If ExifTool is installed but not on PATH, pass its full path with --exiftool."""


def print_error(error: str, **details: Any) -> None:
    print(json.dumps({"ok": False, "error": error, **details}, ensure_ascii=False), file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Search local photos by EXIF/IPTC/XMP metadata.")
    parser.add_argument("--root", required=True, action="append", help="Photo folder to search. Can be repeated.")
    parser.add_argument("--query", required=True, action="append", help="Metadata text to search. Can be repeated.")
    parser.add_argument("--limit", type=int, default=20, help="Maximum number of matches to print.")
    parser.add_argument("--scan-limit", type=int, default=0, help="Maximum candidate files to inspect after sorting.")
    parser.add_argument("--batch-size", type=int, default=100, help="Files per ExifTool call.")
    parser.add_argument("--case-sensitive", action="store_true", help="Use case-sensitive matching.")
    parser.add_argument("--format", choices=["json", "text"], default="json", help="Output format.")
    parser.add_argument("--exiftool", default="exiftool", help="ExifTool executable path.")
    parser.add_argument(
        "--extension",
        action="append",
        help="Image extension to include, for example jpg. Can be repeated. Defaults to common image formats.",
    )
    return parser.parse_args()


def validate_args(args: argparse.Namespace) -> None:
    if args.limit < 1:
        raise ValueError("--limit must be at least 1")
    if args.scan_limit < 0:
        raise ValueError("--scan-limit must not be negative")
    if args.batch_size < 1:
        raise ValueError("--batch-size must be at least 1")
    if any(not value.strip() for value in args.query):
        raise ValueError("--query must not be empty")


def normalize_extension(value: str) -> str:
    text = value.strip().lower()
    if not text:
        return text
    return text if text.startswith(".") else "." + text


def iter_image_files(roots: Iterable[Path], extensions: set[str]) -> List[Path]:
    files: List[Path] = []
    for root in roots:
        if root.is_file() and root.suffix.lower() in extensions:
            files.append(root)
            continue
        if not root.is_dir():
            print("Skipping missing or non-directory root: {}".format(root), file=sys.stderr)
            continue
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() in extensions:
                files.append(path)
    return sorted(files, key=candidate_sort_key, reverse=True)


def candidate_sort_key(path: Path) -> tuple[str, float, str]:
    text = str(path)
    inferred = infer_path_timestamp(path)
    try:
        modified = path.stat().st_mtime
    except OSError:
        modified = 0.0
    return inferred, modified, text


def infer_path_timestamp(path: Path) -> str:
    text = str(path)
    full = re.search(r"(20\d{2})[-_/\\. ]([01]\d)[-_/\\. ]([0-3]\d)(?:[ _.-]?([0-2]\d)[ ._-]?([0-5]\d)[ ._-]?([0-5]\d))?", text)
    if full:
        year, month, day, hour, minute, second = full.groups()
        return "{}{}{}{}{}{}".format(year, month, day, hour or "00", minute or "00", second or "00")
    year_month = re.search(r"(20\d{2})[-_/\\.]([01]\d)(?!\d)", text)
    if year_month:
        year, month = year_month.groups()
        return "{}{}00000000".format(year, month)
    year = re.search(r"(?:^|[\\/])(20\d{2})(?:$|[\\/])", text)
    if year:
        return "{}0000000000".format(year.group(1))
    return ""


def chunks(values: List[Path], size: int) -> Iterable[List[Path]]:
    size = max(1, size)
    for index in range(0, len(values), size):
        yield values[index : index + size]


def write_argfile(exiftool_args: List[str]) -> str:
    handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="\n", delete=False, suffix=".args")
    try:
        for item in exiftool_args:
            handle.write(item)
            handle.write("\n")
        return handle.name
    finally:
        handle.close()


def run_exiftool(exiftool: str, files: List[Path]) -> tuple[list[dict[str, Any]], str]:
    args = [
        "-charset",
        "ExifTool=UTF8",
        "-charset",
        "UTF8",
        "-charset",
        "filename=UTF8",
        "-q",
        "-q",
        "-j",
        "-a",
        "-G1",
        "-s",
        *["-" + tag for tag in DATE_KEYS_TO_TAGS],
        *["-" + tag for tag in SEARCH_TAGS],
        *[str(path) for path in files],
    ]
    argfile = write_argfile(args)
    try:
        process = subprocess.run(
            [exiftool, "-@", argfile],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    finally:
        try:
            os.unlink(argfile)
        except OSError:
            pass

    stdout = process.stdout.decode("utf-8", errors="replace")
    stderr = process.stderr.decode("utf-8", errors="replace").strip()
    if process.returncode != 0:
        raise RuntimeError(stderr or "ExifTool failed with exit code {}".format(process.returncode))
    if not stdout.strip():
        return [], stderr
    data = json.loads(stdout)
    if not isinstance(data, list):
        raise ValueError("ExifTool JSON output was not a list.")
    return [item for item in data if isinstance(item, dict)], stderr


DATE_KEYS_TO_TAGS = [
    "DateTimeOriginal",
    "CreateDate",
    "ModifyDate",
    "FileModifyDate",
]


def flatten(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, list):
        return " ".join(flatten(item) for item in value)
    if isinstance(value, dict):
        return " ".join(flatten(item) for item in value.values())
    return str(value)


def contains_query(haystack: str, queries: list[str], case_sensitive: bool) -> bool:
    if case_sensitive:
        return all(query in haystack for query in queries)
    folded = haystack.casefold()
    return all(query.casefold() in folded for query in queries)


def get_first(item: dict[str, Any], keys: Iterable[str]) -> Any:
    for key in keys:
        value = item.get(key)
        if value not in (None, ""):
            return value
    return None


def date_text(item: dict[str, Any]) -> str:
    value = get_first(item, DATE_KEYS)
    return str(value) if value not in (None, "") else ""


def date_sort_key(value: str) -> datetime:
    text = re.sub(r"([+-]\d{2}:?\d{2})$", "", value).split(".")[0].strip()
    for fmt in ("%Y:%m:%d %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    return datetime.min


def searched_text(item: dict[str, Any]) -> str:
    parts = []
    for key, value in item.items():
        if any(key.endswith(":" + tag) or key == tag for tag in SEARCH_TAGS):
            parts.append(flatten(value))
    return " ".join(parts)


def compact_match(path: Path, item: dict[str, Any]) -> dict[str, Any]:
    return {
        "path": str(path),
        "date": date_text(item),
        "keywords": get_first(item, ("IPTC:Keywords", "XMP-dc:Subject")),
        "subject": get_first(item, ("XMP-dc:Subject", "IPTC:Keywords")),
        "hierarchical_subject": get_first(item, ("XMP-lr:HierarchicalSubject",)),
        "title": get_first(item, ("XMP-dc:Title", "IPTC:ObjectName")),
        "description": get_first(item, ("XMP-dc:Description", "IFD0:ImageDescription", "IPTC:Caption-Abstract")),
    }


def print_text(matches: list[dict[str, Any]]) -> None:
    for item in matches:
        date = item.get("date") or "unknown date"
        print("{}\t{}".format(date, item["path"]))


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    args = parse_args()
    validate_args(args)

    roots = [Path(value).expanduser().resolve() for value in args.root]
    missing_roots = [str(root) for root in roots if not root.exists()]
    roots = [root for root in roots if root.exists()]
    if not roots:
        raise RuntimeError("None of the requested roots exist")
    extensions = {normalize_extension(value) for value in args.extension} if args.extension else DEFAULT_EXTENSIONS
    extensions = {value for value in extensions if value}
    if not shutil.which(args.exiftool) and not Path(args.exiftool).exists():
        print_error("ExifTool not found.", next_step=EXIFTOOL_INSTALL_HELP)
        return 2
    files = iter_image_files(roots, extensions)
    if args.scan_limit > 0:
        files = files[: args.scan_limit]

    matches: list[dict[str, Any]] = []
    warnings: list[str] = []
    scanned_count = 0
    for batch in chunks(files, args.batch_size):
        scanned_count += len(batch)
        items, warning = run_exiftool(args.exiftool, batch)
        if warning:
            warnings.append(warning)
        batch_paths = {
            os.path.normcase(str(path.resolve())): path
            for path in batch
        }
        for item in items:
            source_file = item.get("SourceFile")
            if not isinstance(source_file, str):
                continue
            path = batch_paths.get(os.path.normcase(str(Path(source_file).expanduser().resolve())))
            if path is None:
                continue
            if contains_query(searched_text(item), args.query, args.case_sensitive):
                matches.append(compact_match(path, item))

    matches.sort(key=lambda item: date_sort_key(item.get("date") or ""), reverse=True)
    limited = matches[: max(0, args.limit)]
    if args.format == "text":
        print_text(limited)
    else:
        print(
            json.dumps(
                {
                    "ok": True,
                    "matches": limited,
                    "match_count": len(matches),
                    "scanned_count": scanned_count,
                    "candidate_count": len(files),
                    **({"missing_roots": missing_roots} if missing_roots else {}),
                    **({"warnings": warnings} if warnings else {}),
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print_error("Interrupted")
        raise SystemExit(130)
    except Exception as error:
        print_error(str(error), error_type=type(error).__name__)
        raise SystemExit(1)
