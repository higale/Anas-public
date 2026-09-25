# Anas

[简体中文](README.md) · [English](README.en.md)

Anas 是基于 Electron、React 和 TypeScript 构建的本地桌面 Agent。每个项目可以选择自己的上下文、工具、技能和子 Agent。配置与会话保存在本地；请求模型时，会将任务所需的内容发送给所选模型供应商。

[GitHub](https://github.com/higale/Anas-public) · [MIT 协议](LICENSE) · [参与贡献](CONTRIBUTING.md)

公开仓库定期接收源码快照，每次同步新增一个提交；发布标签与 `package.json` 中的版本号一致。日常开发历史单独保留。

## 文档

- 用户指南：[English](data/help/USER_GUIDE.en.md) · [中文](data/help/USER_GUIDE.zh-CN.md)
- Agent Skills：[English](data/help/AGENT_SKILLS.en.md) · [中文](data/help/AGENT_SKILLS.zh-CN.md)
- [自定义工具包](docs/CUSTOM_TOOLS.md)
- [当前状态存储](docs/CURRENT_STATE_STORAGE.md)
- [安全与审批模型](docs/SECURITY_MODEL.md)
- [框架补丁](docs/FRAMEWORK_PATCHES.md)
- [编程能力评估](docs/CODING_EVALUATION.md)
- [开发规则](AGENTS.md)

应用的“帮助”菜单会在右侧工作区打开内置指南，提供目录并保存阅读位置。

## 功能

- 支持 OpenAI 兼容和 Anthropic 兼容的模型供应商、流式回复、上下文压缩，以及审批后的任务恢复。
- 在设置中配置默认能力，按需为项目定制，并独立配置子 Agent。
- 内置文件、图片、网络、记忆和命令工具，随应用提供 ripgrep，支持 MCP 与自定义工具包。
- 支持用户级和项目级 Skills、提示词快捷输入、输入历史，以及语音输入与输出。
- 支持文本、图片、PDF 和 DOCX 附件。图片通过原生多模态内容块发送，文档在本地提取内容。
- 可调整宽度的右侧工作区，用于子 Agent、帮助、只读 Git 差异及已记录的文件差异。Monaco 支持行内和并排对比，设置页保持双栏布局。
- 本地数据备份、恢复、日志和启动恢复。

能力选择与执行审批分别生效。各能力包含的工具和依赖见用户指南；三种会话访问模式见安全模型。

## 运行时架构

LangChain、LangGraph 和 Deep Agents 负责模型与工具循环、消息、checkpoint、interrupt、重试及子 Agent 调度。LangGraph 当前 checkpoint 状态是会话的唯一权威来源。Anas 负责 Electron 生命周期、配置、项目、界面展示、备份及其他产品服务。

每个主会话及其子 Agent 共用一个 SQLite 数据库；catalog 保存会话位置和共享记忆。完整消息逐条存储，不维护第二份由应用管理的模型历史。当前实现拒绝不支持的存储格式，尚无旧格式迁移路径。首个公开的 `3.0.0` 版本将成为兼容基线；后续格式变更必须按[兼容规则](AGENTS.md#发布兼容性)为受支持的已发布版本提供升级路径。发布前的开发格式，以及用旧应用读取新版本数据，不在此保证范围内。详见[当前状态存储](docs/CURRENT_STATE_STORAGE.md)。

普通工具共用受管执行器，提供 **8 个执行槽位**，活跃与排队调用总数上限为 **64**。槽位繁忙或修改操作冲突时自动排队。启用后台工具后，等待或运行超过 10 秒的调用会返回可用于监督的句柄。取消操作会保留执行归属，直到实际执行器结束；外部操作结果不确定时会明确标记。规划、子 Agent 调度、用户提问和监督不占用此执行池。

自定义工具在各自的包目录中运行。用户工具包位于数据目录的 `tools/` 下；项目工具包位于各源码目录的 `.agents/tools/` 下。使用前必须明确选择相应能力。执行和导入规则见[自定义工具包](docs/CUSTOM_TOOLS.md)。

Shell 命令保留模型提供的命令文本、参数及搜索行为。受支持的只读命令通过目标与环境检查后可以自动获批；分析过程不会为获得批准而改写命令。其他命令遵循所选访问模式。平台支持与恢复规则由安全模型定义。

## 开发

先阅读 [AGENTS.md](AGENTS.md)，检查工作区和近期 Git 历史，再安装当前平台的依赖。内置 ripgrep 和原生模块需要 npm 可选依赖，请勿跳过。

使用 Node.js 24、npm 和 Git。在目标操作系统上安装依赖，不要跨平台复制 `node_modules`。如果没有匹配的预编译原生模块，可能需要安装平台构建工具。只有使用 Python 工具、Skills 或相关测试时才需要 Python。在 Windows PowerShell 中，如果执行策略阻止 `npm.ps1`，请使用 `npm.cmd`。

```bash
npm ci
npm run dev
npm run typecheck
npm test -- <test-file>
npm run build
```

启动后，在“设置 > 模型”中添加模型供应商，再在消息工具栏选择模型。应用不内置模型服务凭据。`data/config/` 和 `data/.env` 是随包分发的默认配置；个人设置与密钥应保存在应用数据目录中。

`build` 会检查类型，构建主进程、preload 和渲染进程资源，并验证主进程依赖边界。按修改的行为运行相关测试。Electron 检查使用隔离的数据目录：

```bash
npm run test:e2e -- --help-only
npm run test:e2e -- --startup-only
npm run test:e2e -- --storage-only
```

构建、打包与后端测试共用生成文件和原生依赖，请串行运行。

| 目录 | 职责 |
| --- | --- |
| `src/main/agent/` | Agent 构建、持久化、生命周期与 IPC |
| `src/main/` | Electron 与产品服务 |
| `src/preload/` | 带类型的 `window.gale` 桥接接口 |
| `src/renderer/` | React 工作区、设置与共享控件 |
| `src/shared/` | 共享类型与辅助函数 |
| `data/` | 内置配置、帮助、语言包、技能、示例和资源 |
| `patches/` | 由 `postinstall` 应用的必要依赖补丁 |

## 数据目录

默认目录为 `~/.gale<program-name>/`，通常是 `~/.galeAnas/`。打包后的程序名由实际可执行文件或应用包名称决定，重命名后的副本可以使用独立的数据目录。

可以通过应用的第一个参数、`--data-dir <path>` 或 `--data-dir=<path>` 指定其他目录。相对路径以启动目录为基准解析，不允许使用文件系统根目录。

```bash
Anas.exe --data-dir "D:\Anas Data\Research"
./Anas.AppImage --data-dir "$HOME/Anas Data/Research"
npm run dev -- -- --data-dir "./runtime-data/research"
```

| 数据目录内的路径 | 内容 |
| --- | --- |
| `config/` | 设置、默认能力、供应商与模型、子 Agent、MCP、Skill 来源与可用性、自定义工具排序 |
| `sqlite/catalog.sqlite` | 主会话目录与共享记忆 |
| `sqlite/conversations/<threadId>.sqlite` | 一个主会话及其子 Agent |
| `projects.json` | 项目定义与源码目录 |
| `.env` | 应用环境变量 |
| `attachments/`、`file_edits/` | 已保存的附件与文件修改恢复材料 |
| `skills/`、`tools/` | 用户管理的包 |
| `skills_system/`、`skills_examples/`、`tools_examples/` | 启动时刷新的内置包；示例需先导入再使用 |
| `help/`、`lang/` | 帮助与语言包 |
| `assets/`、`log/`、`cache/`、`tmp/`、`electron/` | 资源、日志、缓存、临时文件与 Electron 用户配置 |

项目源码目录与应用数据相互独立。备份包含用户工具和 Skill 包，并使用 SQLite 快照；不备份项目源码目录或外部 Skill 根目录，也不包含 `dev/`、`electron/`、`log/` 和 `tmp/`。恢复时会校验并暂存归档，创建恢复前备份，替换应用数据，然后重新加载应用。

内置帮助、系统 Skills、示例和内置语言包会由应用刷新。需要定制时，请修改用户包或添加独立的语言文件。详见[语言包](data/lang/README.md)。

## 打包

```bash
npm run pack       # 本地未压缩的应用目录
npm run dist       # pack 的别名
npm run portable   # Windows x64 便携包
npm run pack:win:release  # Windows x64 完整应用文件夹 ZIP
npm run pack:mac:release  # 当前 Mac 架构的 ad-hoc 签名 DMG
```

在 macOS 上，`pack` 会在 `release-build/` 下生成 ad-hoc 签名的应用，不使用证书签名、时间戳或公证，也不需要 `sudo`。打包时会校验内置依赖，包括原生 ripgrep；跨平台构建需要目标平台对应的包。

`pack:mac:release` 在 Mac 上运行：Apple Silicon 生成 ARM64 DMG，Intel 生成 x64 DMG，输出至 `release-macos/`。它采用 ad-hoc 签名，不需要 Apple 开发者账户、签名证书、时间戳或公证。构建会检查签名，并对打包后的应用进行冒烟检查。下载的应用在首次尝试启动后，可能需要在“系统设置 > 隐私与安全”中选择“仍要打开”。

`pack:win:release` 在 Windows x64 上运行，验证应用后生成 `release-build/Anas-<version>-windows-x64.zip`。解压后运行 `Anas/Anas.exe`，请保留整个文件夹。用户数据仍使用正常的应用数据目录。除非明确设置镜像环境变量，否则发布命令使用标准 Electron 下载地址；命令本身不会上传安装包。

推送 `v<version>` 标签时，[GitHub Actions 工作流](.github/workflows/release.yml)会在各平台原生主机上构建三个安装包。只有全部构建通过后，才会创建 GitHub Release，附上三个下载文件及 SHA-256 校验值。手动选择 **Run workflow** 只生成可下载的构建产物，不创建 Release。仓库配置和发布步骤见[源码快照发布](docs/SOURCE_PUBLISHING.md)。

### 打开下载的 macOS 应用

从 [GitHub Releases](https://github.com/higale/Anas-public/releases) 下载适合你 Mac 架构的 DMG，打开后将 Anas 拖入“应用程序”，再启动安装后的副本。如果 macOS 因无法验证开发者而阻止启动，请按 [Apple 的说明](https://support.apple.com/102445)，在“系统设置 > 隐私与安全”中选择“仍要打开”，然后确认“打开”。

如果上述方法仍未解决下载隔离问题，且你信任此版本，请先将 DMG 的 `shasum -a 256` 输出与该 Release 的 `SHA256SUMS.txt` 对应条目比较，再仅移除已安装 Anas 应用的隔离属性：

```bash
xattr -r -d com.apple.quarantine "/Applications/Anas.app"
```

如果安装在其他位置，请修改路径。仅在权限不足且确认路径正确时，才在命令前添加 `sudo`。此操作只移除下载隔离标记，不修复损坏的应用，也不提供 Apple 公证。签名校验失败时请重新下载，不要用此方法绕过恶意软件警告。

发布构建已应用并验证 ad-hoc 签名。用户通常不应运行 `codesign --force --deep --sign -`：它会替换嵌套代码的签名，[Apple 将深度签名限定为应急修复用途](https://developer.apple.com/library/archive/technotes/tn2206/)。开发者可以通过 `npm run pack:mac:release` 重新构建。未来如果采用 [Developer ID 签名与 Apple 公证](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)，可以避免因开发者身份或缺少公证导致的拦截；当前版本使用 ad-hoc 签名。

## 开源协议

Anas 使用 [MIT 协议](LICENSE)，版权归 © 2026 gale 所有。第三方组件保留各自的协议，详见[第三方声明](THIRD_PARTY_NOTICES.md)。

维护者可以按[源码快照发布](docs/SOURCE_PUBLISHING.md)的流程发布版本，无需公开日常开发历史。
