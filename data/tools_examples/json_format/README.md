# JSON 格式化 / JSON Formatting

## 中文

依赖 Python 3，无第三方包。命令直接填写脚本路径，Anas 自动查找本机可用的 Python 3；需要指定解释器或虚拟环境时，可在命令前填写其程序路径。

参数示例：`{"value":{"b":2,"a":"中文"},"sort_keys":true}`。stdout 返回两空格缩进的 JSON 文本，不添加结尾换行；不读写文件。

格式化结果超过 100000 UTF-8 字节时明确报错，不截断结果。

## English

Requires Python 3 with no third-party packages. Set the command to the script path; Anas locates an available local Python 3 interpreter automatically. To use a specific interpreter or virtual environment, prefix the script path with its executable path.

Example arguments: `{"value":{"b":2,"a":"中文"},"sort_keys":true}`. Writes JSON with two-space indentation to stdout without a trailing newline. It does not read or write files.

If the formatted output exceeds 100000 UTF-8 bytes, the tool reports an error instead of truncating it.
