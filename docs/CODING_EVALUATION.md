# 固定编码评测

评测使用真实的 `AgentRuntime`、Agent factory、Deep Agents 图、工具、授权、压缩和 SQLite checkpoint。脚本基线固定模型调用序列，用于检查执行与记录；供应商入口使用显式配置的真实模型。两者不能互相替代模型质量证据。

## 运行

在仓库根目录完成 `npm ci` 后执行：

```sh
npm run eval:coding
# 单独调试一个场景
npm run eval:coding -- -t empty-sum
```

评测使用独立的 [Vitest 配置](../vitest.evaluation.config.ts)，不随普通后端测试运行。应用数据目录是进程级状态，因此样本使用单 worker 串行执行，不要与 build、打包或原生依赖重建同时运行。每个样本使用独立的临时工作区、配置和 SQLite 数据库；脚本基线不读取日常配置或模型凭据。

报告写入 `out/evaluations/<时间戳-UUID>/`，包含样本 JSON 和汇总 `results.json`。`out` 会被下一次 build 清理，需保留的报告应另行保存。超时或取消交由 runtime shutdown 排空，清理和结果落盘完成后才开始下一样本。评测不会自动批准 interrupt，意外授权请求使样本失败。

接受全量结果时，同时检查命令退出码和汇总字段：

- `complete`、`sourcesStable`、`configurationStable` 均为 `true`；
- `passedSamples` 与 `expectedSamples` 相等；
- 脚本基线的 `cancellationDiagnostic` 为 `passed`；供应商入口此项为 `not-run`。

筛选运行不能当作全量通过。评测期间新增、删除或修改纳入指纹的源码、默认配置、锁文件或补丁，会记录到 `changedSourceFiles` 并使命令失败；供应商源配置也在开始、结束时核对指纹。

## 场景与矩阵

[任务定义](../src/evaluation/codingTasks.ts) 是输入、夹具、调用序列和期望结果的来源；[评测入口](../src/evaluation/codingSuite.ts) 决定运行矩阵。

| 范围 | 场景 |
| --- | --- |
| 修改与定位 | `empty-sum`、`rename-export`、`merge-settings`、`diagnose-range`、`find-owner` |
| 搜索与并行修改 | `large-rg-owner`、`parallel-patches` |
| 项目规则 | `nested-rules`、`new-rule-redecision`、`directory-move-rules`、`rule-budget-terminal` |
| 压缩及接续 | `automatic-compression-rules`、`compression-resume`、`compression-rules`、`compression-scoped-redecision` |
| 审核 | `review-regression`、`review-clean` |
| 文件操作及失败边界 | `file-tool-roundtrip`、`invalid-path-recovery`、`external-edit`、`ambiguous-context`、`batch-preflight` |
| 主子能力组合 | `subagent-independent-writer`、`subagent-restricted-writer`、`subagent-child-reader`、`subagent-shared-writer` |
| 子任务文件往返 | `subagent-file-roundtrip-independent`、`subagent-file-roundtrip-restricted` |

脚本基线有 28 个场景，对照普通/编码模式和三种访问模式。Windows 共 168 个样本；当前评测入口在所有非 Windows 平台将 `large-rg-owner` 限为完整访问，因此共 164 个样本，其余组合列入 `excludedCombinations`。这是评测矩阵的限制，不能据此判断产品缺少 macOS 只读 Shell 分析能力。另有 1 项取消隔离诊断，不计入质量样本；每个组合只运行一次。

理解覆盖范围时需保留以下区别：

- 功能任务通过独立的 Node 行为测试接受等价实现，同时核对无关文件的内容哈希及新增、删除。`evaluatorTests` 是判定器执行测试的证据，不是 Agent 主动运行测试的证据。
- 规则和压缩场景检查实际模型请求、文件写入时序及 checkpoint。脚本摘要不包含规则正文，用于验证产品重新注入完整规则；不证明真实模型的压缩质量或规则遵循能力。
- `large-rg-owner` 在有界合成仓库中实际执行内置 rg，按调用 ID 校验完整工具结果中的文件集合、路径、行号和原文；它不是大仓库性能或模型自主搜索评测。
- 文件往返场景只覆盖夹具选定的 11 个文件工具。子任务经真实 `start_subagent` / `wait_subagent` 执行，检查实际工具归属、能力交集和 checkpoint 重开；不能推断所有文件工具、嵌套子任务或全部失败边界均已覆盖。
- 边界任务必须同时出现预期的未执行结果并保持要求的文件状态；空操作、提前失败或任意 `run_failed` 不能冒充通过。意外错误仍使样本失败。

## 结果解释

当前汇总格式为 `schemaVersion: 5`。报告包含应用版本、Git revision/dirty 状态、平台、Electron/Node 版本、源码与配置指纹、任务输入、模式、访问范围、调用计数、文件判定、压缩、checkpoint 重开结果和错误。工具结果及意外 interrupt 只保留有界诊断片段；截断标记不能被解释为完整证据。

| 字段 | 含义与限制 |
| --- | --- |
| `evidence` | `scripted-runtime` 或 `provider-runtime`，区分固定脚本与真实模型 |
| `toolCalls` / `toolOutputs` | 前者统计 `tool_started` 事件；后者按调用 ID 去重并注明 tool-event/checkpoint 来源。checkpoint 补录的预检结果不代表工具实际执行 |
| `reviewScore` | 按冻结差异的文件、侧、行范围和 P0–P3 优先级匹配固定目标；重复、不匹配和遗漏分别记录。precision/recall 仅表示定位匹配 |
| `semanticCorrectness` | 为 `null`，定位评分不判定审核文本的触发条件、影响和论证是否正确 |
| `tokens` | 供应商成功返回的标准 `usage_metadata` 汇总及逐调用明细；覆盖状态为 complete/partial/unavailable，不包含无法观测的 SDK 内部重试、失败请求计费或缓存价格 |
| `modelTrace` | 供应商的 LangChain 回调记录，包含调用身份、消息及工具参数指纹、终态和耗时；是 SDK 序列化前的规范化消息，非 HTTP 抓包 |

脚本样本的 `tokens`、`modelTrace`、`modelQuality`、`agentExecutedTests` 为 `null`，不以零冒充测量。耗时包含配置、运行、检查、重开和清理。供应商 trace 最多记录 128 次调用、每次 256 条输入和输出消息，省略时标记；记录截断时不宣称用量覆盖完整。流式累计用量依赖当前[框架补丁](FRAMEWORK_PATCHES.md)，用量覆盖完整仍不等于账单完整。

判定实现与正反例见 [codingResults.ts](../src/evaluation/codingResults.ts)、[行为测试执行器](../src/evaluation/codingBehavior.ts)和[判定器测试](../src/evaluation/codingResults.test.ts)。产品接受决定应与原始测试结果分开，不改写失败样本、评分或覆盖字段。

## 真实供应商

真实调用会使用模型凭据，配置目录必须由用户明确指定或明确授权用于测试：

```sh
ANAS_EVAL_CONFIG_DIR=/absolute/test-data/config npm run eval:coding:live
# 先跑一个任务的两种模式
ANAS_EVAL_CONFIG_DIR=/absolute/test-data/config npm run eval:coding:live -- -t empty-sum
```

- `ANAS_EVAL_MODEL_ID`：选择该配置中的模型；省略时使用 `settings.json` 的 `default_model_id`。
- `ANAS_EVAL_REPEATS`：每个组合重复次数，默认为 1，允许 1–5。

缺少显式配置目录或模型不存在时直接失败，不搜索日常目录或回退其他模型。普通 `eval:coding` 不会因提供这些变量而切换为网络评测。

供应商入口复制指定 `models.json` 到各样本临时配置，只从 `settings.json` 读取默认模型；保留模型参数、预设、流式及上下文设置。其他设置使用固定基线：英语、关闭 Shell/MCP/子 Agent/Skill/环境注入、每回合最多 16 次模型调用。单样本限时 180 秒，源配置只读，报告不序列化模型凭据。

当前供应商场景为 `empty-sum`、`rename-export`、`merge-settings`、`diagnose-range`、`compression-resume`、`review-regression`、`review-clean`；对照普通/编码模式，访问模式固定允许只读，默认共 14 个样本。真实模型探索时的工具错误单独记录，任务仍须通过行为、文件保护、终态和 checkpoint 检查。审核报告及冻结差异保存在结果中，需独立语义评审，定位分数不能代替该结论。
