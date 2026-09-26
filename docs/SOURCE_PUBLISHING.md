# 源码快照发布

GitHub 目标仓库：`higale/Anas-public`。日常开发仓库与公开仓库拥有独立的 Git 历史，公开仓库每次同步追加一个提交，发布时打 `v<package.json version>` 标签。不要把开发分支合并或推送到公开仓库，也不要每次重建公开历史或强制推送。

## 发布步骤

1. 将公开仓库收到的修改先纳入开发仓库，完成本次变更、文档和版本更新。版本与验证遵循 [AGENTS.md](../AGENTS.md)。
2. 运行 `npm run typecheck`、相关行为测试和 `npm run build`。分发安装包时运行对应的打包校验；完整发布检查可用 `npm run ci:release`，它会重新安装依赖并串行执行现有发布检查。
3. 提交本次开发结果，确认工作区干净。从项目根目录执行 `git archive --format=zip --output=../Anas-source.zip HEAD`，导出该提交的源码。未提交修改和未跟踪文件不在快照内。
4. 拉取公开仓库的最新提交，确认其工作区干净。将快照解压到临时目录，再同步到公开仓库；同步必须包含删除的文件，且保留目标仓库自己的 `.git`。检查解析后的源、目标目录，禁止将日常工作区或它的 `.git` 当作清理目标。
5. 在公开仓库检查 `git diff --stat` 和实际差异，确认只包含要发布的源码。保留 `LICENSE`、`THIRD_PARTY_NOTICES.md`、`data/licenses/`、锁文件和依赖补丁。`data/.env` 是随程序分发的示例模板，不能填入个人配置。
6. 使用 `git add -A` 暂存本次快照并检查 `git diff --cached`。提交标题为 `Release <version>`，正文用简短条目概括自上次同步以来的累计修改，以本次实际差异为准，覆盖主要功能、修复和必要的配置或文档变更，不只描述最后一次开发提交。再创建 `v<version>` 标签。没有内容变更时不创建重复提交；已有标签不能覆盖。
7. 明确推送公开仓库的 `main` 和本次 `v<version>` 标签。不要使用 `--mirror` 或 `--all`。标签触发自动打包，三个平台全部成功后由工作流创建 GitHub Release 并上传文件；无需提前创建 Release。

首次发布时创建新的空仓库并使用 `main`，将源码快照作为根提交；不要从开发仓库克隆出带有原历史的公开仓库。源码归档输出放在工作区外，个人运行数据放在默认应用数据目录，或已忽略的 `runtime-data/` 下。

发布前对最终导出的源码快照检查密钥、个人路径、私有服务地址和误收录的用户数据；另外检查 `data/` 等打包资源中的未跟踪文件，Git 忽略规则不会自动成为打包排除规则。只发布检查过的快照，不复制开发仓库的 `.git`、运行数据或构建日志。

公开仓库的提交和附注标签会公开作者、提交者的姓名与邮箱。首次提交前，在公开仓库单独配置预期的公开署名和 GitHub 提供的 noreply 邮箱，不直接沿用开发仓库的私人邮箱；这些仓库级配置无需更改日常开发身份。

## GitHub 自动打包

将 [.github/workflows/release.yml](../.github/workflows/release.yml) 和 [.github/RELEASE_NOTES.md](../.github/RELEASE_NOTES.md) 一起同步到公开仓库。在仓库的 Settings > Actions > General 中允许工作流运行及官方 `actions/*`；组织策略也须允许发布作业声明 `contents: write`。使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需另配 PAT 或 Apple 证书。

| 平台 | GitHub runner | 发布文件 |
| --- | --- | --- |
| macOS Apple Silicon | `macos-15`，ARM64 | `Anas-<version>-macos-arm64.dmg` |
| macOS Intel | `macos-15-intel`，x64 | `Anas-<version>-macos-x64.dmg` |
| Windows x64 | `windows-2022` | `Anas-<version>-windows-x64.zip` |

每个作业使用 Node.js 24，在本机架构安装锁定依赖、运行 lint、类型检查与构建，再校验打包资源和实际启动。macOS 检查 ad-hoc 签名，不执行证书签名或公证；Windows ZIP 内有完整 `Anas/` 目录，不是安装器或单文件便携 EXE。Release 同时提供 `SHA256SUMS.txt`。

推送的标签必须精确匹配 `package.json` 的 `vMAJOR.MINOR.PATCH`，普通分支推送不会触发打包。工作流进入默认分支后，可在 Actions > Build release packages > Run workflow 手动验证；手动运行只保留 14 天的 Actions 构建产物，不发布 Release。自动发布失败时先检查该版本的 Release 状态；上传中断可能留下草稿，不要覆盖已发布版本或移动标签。

本地仍可运行 `npm run pack`、`npm run pack:mac:release` 或 `npm run pack:win:release`，与 CI 使用相同配置。macOS 未公证应用的首次启动说明随 Release 提供，不能将 ad-hoc 校验结果表述为通过 Gatekeeper 公证验证。
