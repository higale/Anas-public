# 文件 SHA-256 / File SHA-256

## 中文

依赖 Python 3.8 及以上，无第三方包。命令直接填写脚本路径，Anas 自动查找本机可用的 Python 3；需要指定解释器或虚拟环境时，可在命令前填写其程序路径。

参数示例：`{"path":"/absolute/path/archive.zip"}`。每次读取 1 MiB，stdout 返回路径、读取字节数和 SHA-256 的 JSON；失败写入 stderr 并以非零状态退出。

校验期间请保持文件内容不变。超时默认不限制，可在编辑工具时调整。

## English

Requires Python 3.8 or later with no third-party packages. Set the command to the script path; Anas locates an available local Python 3 interpreter automatically. To use a specific interpreter or virtual environment, prefix the script path with its executable path.

Example arguments: `{"path":"/absolute/path/archive.zip"}`. Reads 1 MiB at a time and writes JSON containing the path, bytes read, and SHA-256 to stdout. Failures are written to stderr with a nonzero exit status.

Keep the file unchanged during verification. There is no timeout by default; adjust it in the tool editor if needed.
