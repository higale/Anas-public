#!/usr/bin/env python3
import argparse
import base64
import json
import os
from pathlib import Path
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


STANDARD_API_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
TOKEN_PLAN_API_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"


def configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


def print_error(data: dict[str, object]) -> None:
    print(json.dumps(data, ensure_ascii=False), file=sys.stderr, flush=True)


def api_url_for_key(api_key: str) -> str:
    return TOKEN_PLAN_API_URL if api_key.startswith("sk-sp-") else STANDARD_API_URL


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError("expected a boolean value")


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


def image_input(value: str, max_bytes: int, wan: bool) -> str:
    if value.startswith(("http://", "https://")):
        if not urllib.parse.urlsplit(value).hostname:
            raise RuntimeError("Image URL must include a host")
        return value
    path = Path(value).expanduser()
    formats = {
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
        ".bmp": "image/bmp", ".webp": "image/webp",
    }
    if not wan:
        formats.update({".tif": "image/tiff", ".tiff": "image/tiff", ".gif": "image/gif"})
    mime = formats.get(path.suffix.lower())
    if not mime:
        raise RuntimeError(f"Unsupported image format: {path.suffix}")
    if not path.is_file():
        raise RuntimeError(f"Image file does not exist: {path}")
    with path.open("rb") as stream:
        data = stream.read(max_bytes + 1)
    if not data:
        raise RuntimeError(f"Image file is empty: {path}")
    if len(data) > max_bytes:
        raise RuntimeError(f"Image exceeds {max_bytes // (1024 * 1024)} MB: {path}")
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def build_body(args: argparse.Namespace, model: str) -> bytes:
    wan = model.startswith("wan2.7-image")
    parameters: dict[str, object] = {
        "watermark": args.watermark,
        "n": args.n,
    }
    size = args.size or ("1K" if wan else None if args.image else "1536*1536")
    if size:
        parameters["size"] = size
    if wan:
        parameters["enable_sequential"] = False
    else:
        parameters["prompt_extend"] = True if args.prompt_extend is None else args.prompt_extend
    if args.negative_prompt.strip():
        parameters["negative_prompt"] = args.negative_prompt

    max_bytes = (20 if wan else 10) * 1024 * 1024
    content = [{"image": image_input(value, max_bytes, wan)} for value in args.image]
    content.append({"text": args.prompt})

    body = {
        "model": model,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": content,
                }
            ]
        },
        "parameters": parameters,
    }
    return json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def validate_args(args: argparse.Namespace, model: str) -> None:
    if not args.prompt.strip():
        raise RuntimeError("Prompt is empty")
    if args.n < 1:
        raise RuntimeError("n must be at least 1")
    wan = model.startswith("wan2.7-image")
    if args.size and not re.fullmatch(r"[1-9]\d*\*[1-9]\d*", args.size):
        if not (wan and args.size in {"1K", "2K"}):
            raise RuntimeError("size must use WIDTH*HEIGHT, or 1K/2K for wan2.7-image models")
    if args.timeout <= 0:
        raise RuntimeError("timeout must be a positive number of seconds")
    if len(args.image) > (9 if wan else 3):
        raise RuntimeError(f"Too many input images; this model supports at most {9 if wan else 3}")
    if wan and (args.prompt_extend is not None or args.negative_prompt.strip()):
        raise RuntimeError("--prompt-extend and --negative-prompt are Qwen-only options")


def report_progress(stop: threading.Event, started: float) -> None:
    while not stop.wait(15):
        print_error({"event": "progress", "stage": "waiting", "elapsed_seconds": round(time.monotonic() - started)})


def response_images(payload: object) -> list[str]:
    if not isinstance(payload, dict):
        return []
    output = payload.get("output")
    if not isinstance(output, dict):
        return []
    choices = output.get("choices")
    if not isinstance(choices, list):
        return []
    images: list[str] = []
    for choice in choices:
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue
        for item in content:
            image = item.get("image") if isinstance(item, dict) else None
            if isinstance(image, str) and image:
                images.append(image)
    return images


def api_error(payload: object, fallback: str, status: int | None = None) -> dict[str, object]:
    result: dict[str, object] = {"ok": False, "error": fallback}
    if status is not None:
        result["status"] = status
    if not isinstance(payload, dict):
        return result
    message = payload.get("message")
    if isinstance(message, str) and message:
        result["error"] = message
    code = payload.get("code")
    if isinstance(code, (str, int)):
        result["code"] = code
    request_id = payload.get("request_id") or payload.get("requestId")
    if isinstance(request_id, str) and request_id:
        result["request_id"] = request_id
    return result


def main() -> int:
    configure_stdio()
    parser = argparse.ArgumentParser(description="Generate or edit images with DashScope Qwen/Wan Image API.")
    parser.add_argument("--prompt", required=True, help="Image prompt text.")
    parser.add_argument("--image", action="append", default=[], help="Input image path or HTTP(S) URL; repeat for multiple images.")
    parser.add_argument("--model", help="Model override; otherwise use BAILIAN_IMAGE_MODEL.")
    parser.add_argument("--size", help="WIDTH*HEIGHT, or 1K/2K for Wan; defaults to Wan 1K, Qwen generation 1536*1536, automatic for Qwen editing.")
    parser.add_argument("--prompt-extend", type=parse_bool, help="Qwen only: improve the prompt (default true).")
    parser.add_argument("--watermark", type=parse_bool, default=False, help="Whether to add a watermark.")
    parser.add_argument("--negative-prompt", default="", help="Optional negative prompt.")
    parser.add_argument("--n", type=int, default=1, help="Number of images to generate.")
    parser.add_argument("--timeout", type=int, default=300, help="Network operation timeout in seconds (default 300).")
    args = parser.parse_args()
    model = args.model.strip() if args.model else require_env("BAILIAN_IMAGE_MODEL")
    if not model:
        raise RuntimeError("Model is empty")
    validate_args(args, model)

    api_key = require_env("BAILIAN_IMAGE_API_KEY")
    api_url = api_url_for_key(api_key)
    body = build_body(args, model)
    request = urllib.request.Request(
        api_url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
        },
    )

    print_error({"event": "progress", "stage": "request", "model": model, "input_images": len(args.image)})
    stop = threading.Event()
    reporter = threading.Thread(target=report_progress, args=(stop, time.monotonic()), daemon=True)
    reporter.start()
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            response_body = response.read()
    except urllib.error.HTTPError as error:
        body = error.read()
        try:
            payload = json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = None
        print_error(api_error(payload, "DashScope returned HTTP {}: {}".format(error.code, error.reason), error.code))
        return 1
    except urllib.error.URLError as error:
        timed_out = isinstance(error.reason, (TimeoutError, socket.timeout))
        print_error({
            "ok": False,
            "error": "The DashScope request timed out." if timed_out else str(error.reason),
            "error_type": "TimeoutError" if timed_out else type(error.reason).__name__,
        })
        return 1
    except TimeoutError:
        print_error({"ok": False, "error": "The DashScope request timed out.", "error_type": "TimeoutError"})
        return 1
    finally:
        stop.set()
        reporter.join()

    try:
        payload = json.loads(response_body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        print_error({"ok": False, "error": "DashScope returned invalid JSON.", "error_type": type(error).__name__})
        return 1
    if not response_images(payload):
        print_error(api_error(payload, "DashScope response contained no generated images."))
        return 1
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print_error({"ok": False, "error": str(error), "error_type": type(error).__name__})
        raise SystemExit(1)
