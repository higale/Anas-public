# 原始文本读取 / Raw Text Reading

## 中文

依赖 Python 3，无第三方包。命令直接填写脚本路径，Anas 自动查找本机可用的 Python 3；需要指定解释器或虚拟环境时，可在命令前填写其程序路径。

参数示例：`{"path":"/absolute/path/notes.txt"}`。脚本按字节输出 UTF-8 文件，保留换行和 BOM，不添加行号或结尾换行。

文件最大 512 KiB（524,288 字节）。限制内完整返回；超限、编码错误或读取失败时仅在 stderr 报错，不返回部分正文。保持关闭交互式终端（PTY），避免终端改写换行。

## English

Requires Python 3 with no third-party packages. Set the command to the script path; Anas locates an available local Python 3 interpreter automatically. To use a specific interpreter or virtual environment, prefix the script path with its executable path.

Example arguments: `{"path":"/absolute/path/notes.txt"}`. Writes the UTF-8 file's raw bytes, preserving line endings and any BOM, without adding line numbers or a trailing newline.

The maximum file size is 512 KiB (524,288 bytes). Files within the limit are returned in full. Size, encoding, or read failures produce only an error on stderr, without partial content. Keep the interactive terminal (PTY) disabled to prevent it from rewriting line endings.
