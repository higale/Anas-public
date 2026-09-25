---
name: bailian-image
description: "调用阿里云 DashScope 千问或万相模型生成和编辑图片。用户要求画图、创作插图或海报，或基于本地图片、图片 URL 修改背景、文字、风格及多图融合时使用。"
compatibility: "Requires Python 3.10+, internet access, BAILIAN_IMAGE_API_KEY, and a model set by BAILIAN_IMAGE_MODEL or --model."
---

# 百炼图片生成与编辑

使用 Python 3.10+ 运行 `scripts/generate.py`，不要自行构造 API 请求。配置方式见 [SETUP.md](SETUP.md)。脚本使用同步接口，网络操作超时默认 `300` 秒；宿主执行超时至少预留 `330` 秒，或使用宿主的后台执行机制等待结果。

## 调用

- 将用户需求整理为一段完整、明确的图片描述，通过 `--prompt` 传入。忠实保留主体、文字、构图、风格、颜色和比例等明确约束，不要添加冲突细节。
- **文生图**：不传 `--image`。
- **图片编辑**：通过 `--image` 传入用户指定的本地路径或 HTTP(S) 图片 URL；多图时重复此参数，提示词按顺序称“图一、图二”。本地图片由脚本编码为 Base64，无需先上传；相对图片路径以执行时的工作目录为基准，有空格的路径需加引号。用户指的是附件时，先取得附件实际路径，不猜测文件名。
- 默认使用 `BAILIAN_IMAGE_MODEL`。用户指定模型时用 `--model` 覆盖；编辑必须使用支持图片输入的模型，例如 `qwen-image-3.0-pro` 或 `wan2.7-image`。普通 API Key 和 Token Plan 的模型可用范围不同，以套餐当前支持列表为准，不因失败自动换模型。
- 描述足够生成时直接调用，不要为用户未指定的可选参数追问。
- 脚本默认生成一张：千问文生图传入 `1536*1536`，千问编辑不指定尺寸，由模型选择；万相 2.7 传入 `1K`，编辑时按最后一张输入图的比例输出，约一百万总像素。这些是脚本默认值，不代表服务端默认值。
- 用户要求时设置 `--size WIDTH*HEIGHT`、`--n N` 或 `--watermark true|false`；万相 2.7 也可用 `--size 1K|2K`。`--negative-prompt TEXT` 和 `--prompt-extend true|false` 仅用于千问。需要调整网络等待时间时使用 `--timeout SECONDS`。
- 千问编辑最多输入 3 张、单张不超过 10 MB；万相 2.7 最多输入 9 张、单张不超过 20 MB。万相输入 PNG 不支持透明通道，遇到此类输入应先按用户的背景要求另存不透明副本，不覆盖原图。
- 一次请求只提交一次生成任务。失败或超时后不要自动重试，避免重复计费；用户明确要求重试时除外。

以下命令中的脚本路径相对于本技能目录；实际运行时用解析出的脚本路径：

```bash
python3 scripts/generate.py --prompt "一幅白底水彩植物插画"
python3 scripts/generate.py --model wan2.7-image --image "/path/to/input.png" --prompt "背景改成纯白，保留原图全部文字和布局"
python3 scripts/generate.py --image "/path/to/subject.png" --image "https://example.com/style.jpg" --prompt "保留图一主体，采用图二的配色风格"
```

## 输出

标准输出只包含成功响应 JSON，从 `output.choices[].message.content[].image` 提取所有图片 URL。标准错误包含逐行 JSON：`event: "progress"` 是本地请求准备或每 15 秒的等待计时，不能证明服务端已接收请求，也不代表生成百分比；失败时读取含 `ok: false` 的记录中的 `error`，并按需补充 `status`、`code` 或 `request_id`。未提取到图片时不要声称生成成功。

使用 Markdown 展示每张图片并提供原图链接；除非用户明确要求，否则不要返回原始 JSON：

```markdown
![生成的图片](IMAGE_URL)
[下载原图](IMAGE_URL)
```

## 错误处理

- 缺少环境变量时，明确提示用户配置 `BAILIAN_IMAGE_API_KEY`，以及 `BAILIAN_IMAGE_MODEL` 或 `--model`。
- HTTP 请求或参数校验失败时，简要说明服务返回的错误，并指出需要检查的参数、模型或凭据；不要输出 API Key。
- 超时或中止本地进程不能确认服务端任务已取消。先报告结果不确定，不把同一请求再次提交来探测状态。
