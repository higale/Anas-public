#!/usr/bin/env python3
import argparse
import asyncio
import json
import os
import signal
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from uuid import uuid4


DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"


class TerminationRequested(Exception):
    pass


def configure_stdio():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def json_print(data, *, stream=None):
    if stream is None:
        stream = sys.stdout
    print(json.dumps(data, ensure_ascii=False, indent=2), file=stream)


def json_error(data):
    json_print(data, stream=sys.stderr)


def handle_termination(_signum, _frame):
    raise TerminationRequested


def positive_int(value):
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be at least 1")
    return parsed


def execution_error(error, timeout):
    if isinstance(error, asyncio.TimeoutError):
        return f"Timed out after {timeout} seconds."
    return str(error) or type(error).__name__


def documents_dir():
    path = None
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            ) as key:
                value, _ = winreg.QueryValueEx(key, "Personal")
                path = Path(os.path.expandvars(value)).expanduser()
        except (ImportError, OSError, TypeError):
            pass
    if path is None:
        path = Path.home() / "Documents"
    path.mkdir(parents=True, exist_ok=True)
    return path


def default_output_path():
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    return documents_dir() / f"edge-tts-{stamp}.mp3"


def output_path(value):
    if not value:
        return default_output_path()
    path = Path(value).expanduser().resolve()
    if path.suffix.lower() != ".mp3":
        raise ValueError("--output must use the .mp3 extension")
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def command_executors():
    executors = []
    direct = shutil.which("edge-tts")
    if direct:
        executors.append([direct])
    uvx = shutil.which("uvx")
    if uvx:
        executors.append([uvx, "edge-tts"])
    return executors


def terminate_process_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if result.returncode != 0 and process.poll() is None:
                process.kill()
        except OSError:
            process.kill()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except OSError:
            if process.poll() is None:
                process.kill()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()


def run_executor(base, args, timeout):
    executor = " ".join(base)
    environment = os.environ.copy()
    environment["PYTHONIOENCODING"] = "utf-8"
    environment["PYTHONUTF8"] = "1"
    popen_kwargs = {
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "env": environment,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
    }
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        popen_kwargs["start_new_session"] = True
    try:
        process = subprocess.Popen([*base, *args], **popen_kwargs)
    except OSError as exc:
        return {"ok": False, "executor": executor, "error": str(exc), "unavailable": True}
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        terminate_process_tree(process)
        stdout, stderr = process.communicate()
        return {
            "ok": False,
            "executor": executor,
            "error": f"Timed out after {timeout} seconds.",
            "stderr": stderr.strip(),
        }
    except BaseException:
        terminate_process_tree(process)
        process.communicate()
        raise
    if process.returncode == 0:
        return {
            "ok": True,
            "executor": executor,
            "stdout": stdout,
            "stderr": stderr,
        }
    return {
        "ok": False,
        "executor": executor,
        "error": stderr.strip() or stdout.strip() or f"exit code {process.returncode}",
    }


def run_command(args, timeout):
    executors = command_executors()
    if not executors:
        return {
            "ok": False,
            "error": "edge-tts is unavailable. Install the edge-tts Python package, the edge-tts command, or uvx.",
        }
    attempts = []
    for base in executors:
        result = run_executor(base, args, timeout)
        if result["ok"]:
            return result
        attempts.append({
            "executor": result.get("executor"),
            "error": result.get("error"),
        })
        if not result.get("unavailable"):
            result["attempts"] = attempts
            return result
    return {
        "ok": False,
        "error": "No edge-tts command executor could be started.",
        "attempts": attempts,
    }


def temporary_media_path(media_path):
    suffix = media_path.suffix or ".mp3"
    return media_path.with_name(f".{media_path.stem}.{uuid4().hex}.tmp{suffix}")


def remove_file(path):
    try:
        path.unlink()
    except OSError:
        pass


def copy_without_replacing(temporary_path, media_path):
    descriptor = os.open(media_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
    try:
        with temporary_path.open("rb") as source, os.fdopen(descriptor, "wb") as destination:
            descriptor = -1
            shutil.copyfileobj(source, destination)
            destination.flush()
    except BaseException:
        if descriptor >= 0:
            os.close(descriptor)
        remove_file(media_path)
        raise


def commit_media_file(temporary_path, media_path, *, overwrite):
    if not temporary_path.is_file() or temporary_path.stat().st_size <= 0:
        raise RuntimeError("edge-tts finished without producing a non-empty audio file")
    if overwrite:
        os.replace(temporary_path, media_path)
        return
    try:
        if os.name == "nt":
            os.rename(temporary_path, media_path)
        else:
            os.link(temporary_path, media_path)
    except FileExistsError as exc:
        raise RuntimeError(
            "Output file was created while speech was being generated; it was not replaced."
        ) from exc
    except OSError:
        try:
            copy_without_replacing(temporary_path, media_path)
        except FileExistsError as exc:
            raise RuntimeError(
                "Output file was created while speech was being generated; it was not replaced."
            ) from exc


def filter_voices(voices, value):
    if not value:
        return voices
    needle = value.lower()
    return [
        voice for voice in voices
        if needle in json.dumps(voice, ensure_ascii=False).lower()
    ]


async def list_voices_with_module(voice_filter):
    import edge_tts

    voices = await edge_tts.list_voices()
    return filter_voices(voices, voice_filter)


async def generate_with_module(args, media_path):
    import edge_tts

    communicate = edge_tts.Communicate(
        args.text,
        args.voice,
        rate=args.rate,
        volume=args.volume,
        pitch=args.pitch,
    )
    await communicate.save(str(media_path))


async def list_voices(args):
    attempts = []
    try:
        voices = await asyncio.wait_for(
            list_voices_with_module(args.voice_filter),
            timeout=args.timeout,
        )
        json_print({
            "ok": True,
            "executor": "python edge_tts",
            "voices": voices,
        })
        return 0
    except TerminationRequested:
        raise
    except ImportError as exc:
        attempts.append({"executor": "python edge_tts", "error": str(exc)})
    except Exception as exc:
        json_error({
            "ok": False,
            "executor": "python edge_tts",
            "error": execution_error(exc, args.timeout),
        })
        return 1

    command = ["--list-voices"]
    result = run_command(command, args.timeout)
    if result["ok"] and args.voice_filter:
        result["stdout"] = "\n".join(
            line for line in result["stdout"].splitlines()
            if args.voice_filter.lower() in line.lower()
        )
    if result["ok"]:
        json_print(result)
        return 0
    result["attempts"] = [*attempts, *result.get("attempts", [])]
    json_error(result)
    return 1


async def generate(args):
    if not args.text:
        json_error({"ok": False, "error": "--text is required unless --list-voices is used."})
        return 2

    media_path = output_path(args.output)
    if media_path.exists() and not args.overwrite:
        json_error({
            "ok": False,
            "error": "Output file already exists. Choose another path or pass --overwrite after confirming replacement.",
            "output": str(media_path),
        })
        return 2
    temporary_path = temporary_media_path(media_path)
    attempts = []
    try:
        try:
            await asyncio.wait_for(
                generate_with_module(args, temporary_path),
                timeout=args.timeout,
            )
        except TerminationRequested:
            raise
        except ImportError as exc:
            attempts.append({"executor": "python edge_tts", "error": str(exc)})
        except Exception as exc:
            json_error({
                "ok": False,
                "executor": "python edge_tts",
                "error": execution_error(exc, args.timeout),
            })
            return 1
        else:
            try:
                commit_media_file(temporary_path, media_path, overwrite=args.overwrite)
            except Exception as exc:
                json_error({"ok": False, "executor": "python edge_tts", "error": str(exc)})
                return 1
            json_print({
                "ok": True,
                "executor": "python edge_tts",
                "output": str(media_path),
                "voice": args.voice,
                "bytes": media_path.stat().st_size,
            })
            return 0
        remove_file(temporary_path)

        command = [
            "--text", args.text,
            "--voice", args.voice,
            "--write-media", str(temporary_path),
        ]
        if args.rate:
            command.extend(["--rate", args.rate])
        if args.volume:
            command.extend(["--volume", args.volume])
        if args.pitch:
            command.extend(["--pitch", args.pitch])
        result = run_command(command, args.timeout)
        if result["ok"]:
            try:
                commit_media_file(temporary_path, media_path, overwrite=args.overwrite)
                result.update({
                    "output": str(media_path),
                    "voice": args.voice,
                    "bytes": media_path.stat().st_size,
                })
            except Exception as exc:
                result = {"ok": False, "executor": result.get("executor"), "error": str(exc)}
        if result["ok"]:
            json_print(result)
            return 0
        result["attempts"] = [*attempts, *result.get("attempts", [])]
        json_error(result)
        return 1
    finally:
        remove_file(temporary_path)


def parser():
    parser = argparse.ArgumentParser(description="Generate speech audio with Microsoft Edge online TTS.")
    parser.add_argument("--text", help="Text to synthesize.")
    parser.add_argument("--voice", default=DEFAULT_VOICE, help=f"Voice ID. Default: {DEFAULT_VOICE}.")
    parser.add_argument("--output", help="Output audio path. Defaults to Documents/edge-tts-<timestamp>.mp3.")
    parser.add_argument("--overwrite", action="store_true", help="Replace an existing output file.")
    parser.add_argument("--rate", default="+0%", help="Speaking rate, such as +10%% or -5%%.")
    parser.add_argument("--volume", default="+0%", help="Volume, such as +10%% or -5%%.")
    parser.add_argument("--pitch", default="+0Hz", help="Pitch, such as +10Hz or -5Hz.")
    parser.add_argument("--list-voices", action="store_true", help="List available voices.")
    parser.add_argument("--voice-filter", help="Filter voice list output, such as zh-CN.")
    parser.add_argument("--timeout", type=positive_int, default=120, help="Execution timeout in seconds.")
    return parser


async def main():
    args = parser().parse_args()
    if args.list_voices:
        return await list_voices(args)
    return await generate(args)


if __name__ == "__main__":
    configure_stdio()
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, handle_termination)
    try:
        raise SystemExit(asyncio.run(main()))
    except TerminationRequested:
        json_error({"ok": False, "error": "Terminated."})
        raise SystemExit(143)
    except KeyboardInterrupt:
        json_error({"ok": False, "error": "Interrupted."})
        raise SystemExit(130)
    except Exception as exc:
        json_error({"ok": False, "error": str(exc), "error_type": type(exc).__name__})
        raise SystemExit(1)
