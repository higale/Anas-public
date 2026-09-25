"""Offline behavior checks: python3 scripts/test-bailian-image.py."""

import base64
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error


SCRIPT = Path(__file__).resolve().parents[1] / "data/skills_examples/bailian-image/scripts/generate.py"
spec = importlib.util.spec_from_file_location("image_skill", SCRIPT)
skill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(skill)
RESULT = {"output": {"choices": [{"message": {"content": [{"image": "https://example.com/result.png"}]}}]}}


class ImageSkillTests(unittest.TestCase):
    def invoke(self, arguments, model="qwen-image-3.0-pro", key="sk-sp-test", failure=None, result=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        response = io.BytesIO(json.dumps(RESULT if result is None else result).encode())
        with patch.dict(skill.os.environ, {"BAILIAN_IMAGE_API_KEY": key, "BAILIAN_IMAGE_MODEL": model}), \
             patch.object(skill.sys, "argv", [str(SCRIPT), "--prompt", "保留文字，改为白底", *arguments]), \
             patch.object(skill, "configure_stdio"), \
             patch.object(skill.urllib.request, "urlopen", return_value=response, side_effect=failure) as send, \
             redirect_stdout(stdout), redirect_stderr(stderr):
            status = skill.main()
        request = send.call_args.args[0]
        return status, json.loads(request.data), request, send, stdout.getvalue(), stderr.getvalue()

    def test_text_generation_and_standard_endpoint(self):
        status, body, request, _, out, err = self.invoke([], key="sk-test")
        self.assertEqual(status, 0)
        self.assertEqual(request.full_url, skill.STANDARD_API_URL)
        self.assertEqual(body["input"]["messages"][0]["content"], [{"text": "保留文字，改为白底"}])
        self.assertEqual(body["parameters"]["size"], "1536*1536")
        self.assertEqual(json.loads(out), RESULT)
        self.assertEqual(json.loads(err)["stage"], "request")

    def test_local_edit_encodes_original_bytes_and_preserves_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "带 空格.png"
            original = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=")
            path.write_bytes(original)
            status, body, request, _, _, _ = self.invoke(["--image", str(path)])
            self.assertEqual(status, 0)
            self.assertEqual(request.full_url, skill.TOKEN_PLAN_API_URL)
            content = body["input"]["messages"][0]["content"]
            self.assertEqual(base64.b64decode(content[0]["image"].split(",", 1)[1]), original)
            self.assertEqual(path.read_bytes(), original)
            self.assertNotIn("size", body["parameters"])

    def test_wan_override_uses_matching_parameters_and_keeps_image_order(self):
        urls = ["https://example.com/first.png", "https://example.com/second.jpg"]
        status, body, _, _, _, _ = self.invoke(["--model", "wan2.7-image", "--image", urls[0], "--image", urls[1]])
        self.assertEqual(status, 0)
        self.assertEqual(body["model"], "wan2.7-image")
        self.assertEqual(body["parameters"], {"size": "1K", "n": 1, "watermark": False, "enable_sequential": False})
        self.assertEqual(body["input"]["messages"][0]["content"][:2], [{"image": url} for url in urls])

    def test_explicit_size_and_timeout(self):
        _, body, _, send, _, _ = self.invoke(["--size", "1694*646", "--timeout", "60", "--image", "https://example.com/in.png"])
        self.assertEqual(body["parameters"]["size"], "1694*646")
        self.assertEqual(send.call_args.kwargs["timeout"], 60)

    def test_invalid_inputs_do_not_submit(self):
        cases = [
            (["--image", "/does-not-exist/image.png"], "qwen-image-3.0-pro"),
            (["--image", "https://"], "qwen-image-3.0-pro"),
            (["--size", "1K"], "qwen-image-3.0-pro"),
            (["--size", "0*1024"], "qwen-image-3.0-pro"),
            (["--timeout", "0"], "qwen-image-3.0-pro"),
            (["--image", "https://example.com/in.png"] * 4, "qwen-image-3.0-pro"),
            (["--image", "https://example.com/in.png"] * 10, "wan2.7-image"),
            (["--prompt-extend", "true"], "wan2.7-image"),
            (["--negative-prompt", "blurry"], "wan2.7-image"),
        ]
        for arguments, model in cases:
            with self.subTest(arguments=arguments, model=model), patch.object(skill.urllib.request, "urlopen") as send:
                # invoke patches urlopen separately, so exercise validation through main directly.
                with patch.dict(skill.os.environ, {"BAILIAN_IMAGE_API_KEY": "sk-sp-test", "BAILIAN_IMAGE_MODEL": model}), \
                     patch.object(skill.sys, "argv", [str(SCRIPT), "--prompt", "edit", *arguments]), \
                     patch.object(skill, "configure_stdio"), self.assertRaises(RuntimeError):
                    skill.main()
                send.assert_not_called()

    def test_empty_unsupported_and_oversized_local_files(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "input.png"
            path.write_bytes(b"")
            with self.assertRaisesRegex(RuntimeError, "empty"):
                skill.image_input(str(path), 4, False)
            path.write_bytes(b"12345")
            with self.assertRaisesRegex(RuntimeError, "exceeds"):
                skill.image_input(str(path), 4, False)
            with self.assertRaisesRegex(RuntimeError, "Unsupported"):
                skill.image_input(str(path.with_suffix(".txt")), 4, False)

    def test_http_error_is_reported_without_resubmission(self):
        failure = urllib.error.HTTPError("https://example.com", 429, "Busy", {}, io.BytesIO(b'{"code":"Throttling","message":"Try later","request_id":"req-1"}'))
        status, _, _, send, out, err = self.invoke([], failure=failure)
        self.assertEqual(status, 1)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(out, "")
        error = json.loads(err.splitlines()[-1])
        self.assertEqual(error["code"], "Throttling")
        self.assertEqual(error["request_id"], "req-1")
        self.assertNotIn("sk-sp-test", err)

    def test_timeout_is_reported_without_resubmission(self):
        for failure in [TimeoutError(), urllib.error.URLError(TimeoutError())]:
            with self.subTest(failure=failure):
                status, _, _, send, out, err = self.invoke([], failure=failure)
                self.assertEqual(status, 1)
                self.assertEqual(send.call_count, 1)
                self.assertEqual(out, "")
                self.assertEqual(json.loads(err.splitlines()[-1])["error_type"], "TimeoutError")

    def test_response_without_images_is_not_success(self):
        status, _, _, _, out, err = self.invoke([], result={"request_id": "req-2"})
        self.assertEqual(status, 1)
        self.assertEqual(out, "")
        self.assertEqual(json.loads(err.splitlines()[-1])["request_id"], "req-2")

    def test_wait_progress_uses_stderr_only(self):
        class Stop:
            def __init__(self):
                self.calls = 0

            def wait(self, seconds):
                self.calls += 1
                return self.calls > 1

        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr), patch.object(skill.time, "monotonic", return_value=25):
            skill.report_progress(Stop(), 10)
        self.assertEqual(stdout.getvalue(), "")
        self.assertEqual(json.loads(stderr.getvalue()), {"event": "progress", "stage": "waiting", "elapsed_seconds": 15})


if __name__ == "__main__":
    unittest.main()
