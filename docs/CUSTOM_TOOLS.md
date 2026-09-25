# 自定义工具

自定义工具把固定命令和 JSON 参数 Schema 包装成模型可调用的能力。在“设置 → 工具”管理定义，再到“设置 → 能力”、项目或子 Agent 的“自定义工具”分组中勾选启用。新增或导入不会自动启用，界面只保存定义，不生成业务脚本或安装依赖。

## 目录与选择

工具从两个固定来源发现，不支持添加其他来源目录：

- 用户工具：应用数据目录的 `tools/<目录>/TOOL.json`，在全局工具页管理。
- 项目工具：各项目源文件夹的 `.agents/tools/<目录>/TOOL.json`，不进入全局工具管理列表。

`config/tools.json` 保存排序，定义保存在工具包中。文件变化后可刷新，每次新运行重新读取目录。工具页支持新增、编辑、删除、排序和打开目录；删除将整个用户工具目录移到废纸篓。改名会同步修改目录名，保留 ID、选择和排序；目标已存在时拒绝，保存失败回滚。运行中的工具目录不能改名或删除。

项目未开启“定制能力”时使用全局默认选择；开启后使用项目选择。子 Agent 使用自身选择，可勾选“使用当前项目工具”；启用“限制子 Agent 能力”后还需与项目有效范围取交集。

同名工具从有效选择中按项目源文件夹顺序、用户目录的优先级选取；同一来源按保存的顺序选择。高优先项未启用或加载失败时使用下一个，其他项显示覆盖来源。缺失或无效工具保留可取消的能力引用，一个坏包不阻断其他工具。

## 工具包格式

包中可包含 `scripts/`、`README.md` 和资源文件。`TOOL.json` 是 Anas 工具格式，与标准 Agent Skills 的 `SKILL.md` 分开：

```json
{
  "id": "submit-result",
  "name": "submit_result",
  "description": "校验结果标题。",
  "input_schema": {
    "type": "object",
    "properties": { "title": { "type": "string" } },
    "required": ["title"],
    "additionalProperties": false
  },
  "command": "\"{{tool_dir}}/scripts/submit.py\" --mode validate --data {{args}} --verbose",
  "timeout_seconds": 0,
  "interactive": false
}
```

- `id`：1–100 个字母、数字、下划线或连字符，同一来源内唯一。界面新增时自动生成，手动改名或移动目录时应保留。
- `name`：模型可见名称，最多 64 个字符，以字母或下划线开头，其余只用字母、数字、下划线或连字符；不能占用内置、Shell 或 MCP 等保留名称。
- `input_schema`：JSON Schema **2019-09**，根类型必须为 `object`。省略 `$schema` 也使用该版本，声明其他版本会被拒绝；保存和实际执行使用相同校验版本。
- `timeout_seconds`：`0` 表示不限时，正整数表示执行期限，最大 2,147,483 秒；界面留空保存为 `0`。
- `interactive`：是否在启动时分配 PTY，默认 `false`。

`TOOL.json` 最多 128 KiB，每个来源目录最多 2048 个条目。字段校验和命令语法见 [customTools.ts](../src/shared/customTools.ts)，目录发现及导入见 [toolsStore.ts](../src/main/toolsStore.ts)。

## 命令与参数

命令是一个程序及固定参数，必须包含且只包含一个独立的 `{{args}}` 参数。运行时先解析参数，再将它替换为模型提交的完整 JSON 字符串，直接启动进程；JSON 中的引号、换行和 Shell 符号不会被再次解析。JSON 参数最多 1 MiB，同时受系统命令行长度限制，大段内容应通过文件传递。

工作目录始终是 `TOOL.json` 所在目录，相对脚本和资源路径从这里解析，例如 `scripts/run.py {{args}}`。`{{tool_dir}}` 在分词后替换，含空格的目录仍为单个参数；访问项目文件应传入明确路径。

命令语法：

- 空格和换行分隔参数，单引号或双引号包围含空格的参数；相邻引号片段会合并，如 `--label="daily report"`。
- 反斜杠始终为字面字符，包括 `--output "C:\data\"` 中目录末尾的 `\`。要包含双引号，用单引号包围，反之亦然。
- 引号内的 `$`、`&` 等按字面传递；未加引号的 Shell 特殊符号会被拒绝。不执行管道、重定向、变量展开或多条 Shell 命令，复杂逻辑应写入脚本。
- 命令最多 16,384 个字符、128 个参数。

第一项为 `.py` 文件时，Anas 检查脚本后寻找可运行的 Python 3：Windows 依次检测 `python`、`py -3`、`python3`，macOS/Linux 检测 `python3`、`python`。探测每项最多 2.5 秒，使用工具的实际执行环境和工作目录；选定后直接启动该解释器路径。缺少解释器会报错，不自动安装，也不因业务脚本失败而换解释器重试。需要特定版本、虚拟环境或启动参数时，明确填写解释器命令；其他入口按配置直接执行。

上例对应 `scripts/submit.py`：

```python
import argparse
import json
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--mode", required=True)
parser.add_argument("--data", required=True)
parser.add_argument("--verbose", action="store_true")
options = parser.parse_args()
data = json.loads(options.data)
title = data["title"].strip()
if not title:
    parser.error("title 不能只包含空白")
if options.verbose:
    print(f"Mode: {options.mode}", file=sys.stderr)
print(f"已接收标题：{title}")
```

## 结果与交互

成功时 stdout 原样返回模型，可为文本或 JSON；Anas 不解析其中的业务字段来判断成功。需要表示执行失败时应使用非零退出码，诊断日志写入 stderr。错误结果包含原因及已收集的 stdout、stderr；内联 stdout 最多 524,288 字符，stderr 最多 120,000 字符。stdout 超限时附截断说明，成功执行不会仅因截断变为失败。已返回后台句柄的调用可继续读取受管输出；错误或截断不代表没有副作用，不应据此直接重试。

开启“交互式终端（PTY）”时在启动时分配 80 × 24 终端，运行中不能补接。它需要有效能力配置开启“后台工具”，无需同时开启“执行命令”；后台工具关闭时不会向模型提供此工具，但保留选择。

等待与执行合计超过 10 秒后返回后台调用编号：`read_call` 获取 `terminal_id`，`read_call_output` 读取提示，`write_call` 发送文本、按键、EOF 或调整尺寸，`wait_call` 等待完成，`cancel_call` 终止进程树。超时包含等待输入，取消不回滚已经发生的修改。后续输入按[安全模型](SECURITY_MODEL.md)中的终端输入授权与恢复规则处理。

PTY 合并 stdout/stderr，可能改变换行并包含终端控制符；需要保真文件内容的工具应保持非交互模式。执行实现见 [customToolRuntime.ts](../src/main/agent/customToolRuntime.ts)。

## 示例、导入与备份

启动时将随应用打包的 `data/tools_examples/` 同步到数据目录的 `tools_examples/`。“导入工具”默认打开此目录，可多选包含 `TOOL.json` 的工具目录，复制到用户 `tools/`；导入后的副本不随示例更新。

自带示例为 `read_text_raw`、`file_sha256`、`json_format`，只依赖 Python 3。各包 README 说明参数和版本要求；`read_text_raw` 仅接受最多 512 KiB 的 UTF-8 文件，超限报错，保证限制内正文完整返回。

导入保留包 ID、命令、脚本和资源，按选择顺序追加。同名工具、同名目录或重复 ID 拒绝整批导入；每批最多 128 个目录、10000 项、128 MiB、32 层。全部复制校验后才发布，失败清理本批文件并恢复排序，不覆盖现有工具。

每次运行固定工具名称、命令和 Schema。用户工具调用时按 ID 定位当前目录，项目工具使用运行快照中的目录；脚本及依赖按执行时的文件内容运行，不保存脚本副本。写死在命令中的旧绝对路径不会随改名自动改写。

应用备份包含用户 `tools/`、排序、能力选择及 `tools_examples/`，保留普通执行权限和内部有效链接。项目 `.agents/tools/` 及外部链接目标需另行备份；恢复后失效的工具显示错误。

自定义工具复用框架工具循环、受管调用、取消和副作用恢复。它是用户启用的专用能力，不因启动进程增加通用 Shell 审批；不确定结果仍遵循恢复确认。普通自定义工具不强制模型在最终回复前调用，需要“提交成功才结束”的流程应另行定义完成条件。
