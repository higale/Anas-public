---
name: edge-tts-gen
description: "Generate MP3 speech audio from text with Microsoft Edge online TTS. Use when the user asks for text-to-speech, narrated audio, a specific voice, rate, volume, or pitch, or a list of available voices."
compatibility: "Requires Python 3, internet access, filesystem write access, and either the edge_tts Python package, the edge-tts command, or uvx."
---

# Edge TTS

Run `scripts/generate.py` with Python 3. Allow at least 150 seconds for synthesis.

## Synthesize

Pass `--text` with the exact text to speak. Optional arguments:

- `--voice ID` (default `zh-CN-XiaoxiaoNeural`)
- `--output PATH` (use an absolute `.mp3` path; default: a unique file in the user's Documents directory)
- `--rate=+10%`, `--volume=-5%`, or `--pitch=+10Hz`
- `--timeout SECONDS` (default `120`; give the host executor additional time for cleanup)
- `--overwrite` only when the user explicitly approved replacing an existing output file

Use the `--option=value` form for negative rate, volume, or pitch values so they are not parsed as flags.

## List Voices

Pass `--list-voices`, optionally with `--voice-filter zh-CN`. On success, voice data is in `voices` when the Python package runs, or text in `stdout` when a command executor runs. Do not return a large unfiltered voice list unless the user asks for it.

## Output

Parse successful JSON from stdout. Treat synthesis as successful only when `ok` is `true`, `output` is present, and `bytes` is greater than zero. Failures use a nonzero exit status and write JSON to stderr; report `error` and any executor `attempts`, and do not claim that a file was generated.
