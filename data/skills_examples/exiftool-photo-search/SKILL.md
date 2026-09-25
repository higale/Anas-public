---
name: exiftool-photo-search
description: "Search local photos by embedded EXIF, IPTC, or XMP metadata with ExifTool, without building an index. Use when the user wants to find images by person, face-region name, keyword, tag, title, description, or comment. Do not use for visual content recognition, filename search, or metadata edits."
compatibility: "Requires Python 3.9+, local filesystem access, and ExifTool available on PATH or supplied with --exiftool."
---

# ExifTool Photo Search

Run `scripts/search.py` with Python 3.9+. Choose an execution budget appropriate to the selected library; the script has no internal timeout.

## Workflow

1. If the layout is not already known, inspect the requested root's directory structure at a shallow depth. Do not recursively enumerate the entire photo library merely to learn its layout.
2. Choose the smallest roots that cover the user's requested scope. Use date, location, or event folders when they match explicit search constraints; do not exclude other folders based only on a guess about their contents.
3. Pass those absolute paths with `--root`, plus `--query` and any limits, to the script.
4. On success, parse `matches`, `match_count`, `scanned_count`, `candidate_count`, and optional `missing_roots` or `warnings` from standard-output JSON, then present the matches rather than the raw response.

On failure, read standard-error JSON and report `error` plus any `next_step`. If it reports `ExifTool not found`, stop and ask the user to install ExifTool, add it to `PATH`, or provide `--exiftool`; do not attempt shell discovery or an alternate metadata-search fallback.

## Arguments

- `--root PATH`: required; repeat to search multiple roots or individual image files.
- `--query TEXT`: required; repeat for multiple terms. Every repeated term must match.
- `--limit N`: maximum returned matches; default `20`.
- `--scan-limit N`: inspect metadata for at most `N` candidates (`0`, the default, means all). Candidates are ordered by dates inferred from paths, then file modification time, before metadata is read. The script still enumerates all selected roots first.
- `--extension EXT`: repeat to override the default image extensions.
- `--case-sensitive`: require matching case.
- `--exiftool PATH`: use a non-`PATH` ExifTool executable.

Results are sorted by the first available capture/create/modify timestamp, falling back to file modification time, newest first. `match_count` counts all matches among scanned candidates; `matches` is capped by `--limit`. A scan limit, missing root, or read warning can make the search incomplete; report that scope with the results. The search is read-only.

## Display Results

When the client supports local image previews and the user expects to see the photos, render each result using the client's supported local-file syntax. For clients that accept Markdown file URLs, convert the absolute JSON `path` to `file:///`, replace Windows backslashes with forward slashes, and wrap the URL in angle brackets. Always keep the original absolute path below the preview.

If previews are unavailable, list the paths instead.
