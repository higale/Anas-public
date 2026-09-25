# 当前状态存储

LangGraph checkpoint 是会话状态的唯一权威来源。框架负责模型和工具循环、消息 reducer、审批中断、重试、摘要及子 Agent 调度；应用负责物理存储和产品记录。

每个 Agent 仅保存当前状态，不保存可回放的 checkpoint 版本链。完整消息提交 SQLite，未完成的模型流只存在于运行内存和界面中；崩溃可能丢失未提交进度。当前实现拒绝不支持的格式，尚无旧格式迁移路径。

首个 GitHub `3.0.0` 正式发布时的格式将成为兼容基线。后续存储或框架序列化格式变更必须同时提供已发布版本的升级路径，保留用户数据、配置和备份恢复能力；发布前的开发格式不在承诺范围内。具体要求见 [AGENTS.md 的发布兼容性规则](../AGENTS.md#发布兼容性)。这项开发要求不表示当前已实现跨格式迁移，也不承诺旧应用能读取新版本数据。

## 文件与职责

```text
<dataDir>/
  sqlite/
    catalog.sqlite
    conversations/
      <主对话ID>.sqlite
  attachments/
```

[AgentStorage](../src/main/agent/agentStorage.ts) 的 catalog 保存主对话列表、项目归属、库定位、工作区选择及共享记忆。列表查询不打开全部会话库；catalog 的运行状态只是列表投影，会话库保留权威产品状态。

一个主对话及其全部子 Agent 共用会话库，各自使用独立的框架 thread ID。父子关系、运行、审批、效果记录和结果交付可在同库事务内更新。更换项目只修改归属，不搬迁数据库或附件。

[AgentRuntimeCoordinator](../src/main/agent/agentRuntimeCoordinator.ts) 按需创建 runtime，保护运行、审批等待及在途操作持有的连接，按最近使用顺序淘汰空闲连接，最多保留 32 个空闲会话。空闲连接和整份消息状态的内存缓存有独立生命周期。

## 运行中的模型选择

对话产品记录只保存模型 ID 和参数预设 ID；模型、供应商和预设参数以当前应用配置为准。[模型选择解析器](../src/main/agent/modelSelection.ts) 在每次模型请求前重新读取选择和参数。主对话必须有明确选择；子 Agent 未指定模型时沿父子关系实时继承，指定模型后独立解析自己的选择，不复制父 Agent 的参数。

输入框在运行及等待审批期间仍允许选择模型和预设。运行完成事件在资源清理后读取最新对话元数据，保留清理期间修改的模型和预设。设置保存后广播配置，界面立即重算上下文容量、输出预留和压缩阈值；更换请求配置后不沿用旧请求的服务端 token 用量。已发出的请求使用原参数，后续请求及其准备阶段使用新参数。请求准备期间再次修改配置会重新准备，持续变更超过重试上限则明确终止。自动与手动压缩在准备和重试时也检查最新配置；合法变更重新准备摘要输入与预算，失效配置明确终止。模型能力校验和附件、token 投影读取同一框架摘要边界，已压缩历史不再要求新模型具备原历史的工具或图片能力。

模型、供应商或预设被删除、配置无效、有效上下文要求新模型不支持的工具或图片、压缩后仍超出窗口，以及供应商明确拒绝请求时，当前运行以失败结束并展示原因。不会自动切换其他模型或回退旧参数。额外模型参数不得设置由运行时管理的 `input`、`messages`、`system`、`conversation`、`previous_response_id`、远端 `prompt` 模板或旧式 `functions`／`function_call` 工具字段，避免覆盖或绕过 checkpoint 上下文与工具定义。LangGraph 当前状态及已完成工具结果保留，修正选择后可以在同一对话继续。

上下文显示、压缩预算和发送前容量校验共用按当前协议实际发送内容计算的 token 估算，包含重放的推理、工具结果、Responses `instructions` 及输出 JSON Schema，不把旧请求的输出用量当作新输入。请求级参数只计一次，消息片段计数不重复计入。实际保留的每张图片按 1024 token 计入，覆盖附件、工具结果及 Responses 原生生图、代码执行结果，不按图片 URL 或 Base64 长度计数；已省略或被摘要覆盖的图片只计保留文字。Chat Completions 包含适配层追加说明及重复携带的工具文字。服务端用量只校准模型配置及实际输入投影匹配的历史前缀，再加上该响应与后续消息；代码审查的合成报告不遮蔽真实模型用量，报告及工具结果仍计入后续消息。附件移除或截断、摘要替换、记忆召回和工具定义变化都会使旧校准失效，输入未变时保留有效校准。发送前容量校验也保留有效服务端校准的下限，缩小窗口或关闭压缩不会绕过该校验。

记忆召回先于压缩预算判断。自动和手动压缩都检查完整摘要输入的容量，不能通过丢弃摘要源来推进历史截断；输入超限或摘要为空时明确终止并保留历史。压缩保留完整的待处理图片及工具调用关系；本地容量溢出进入框架压缩和工具结果收缩，必要上下文仍无法容纳时明确终止。压缩统计使用压缩前的有效上下文及最终发送投影，包含系统指令和工具定义。转入简单聊天的历史先按原始 checkpoint 应用摘要边界，再剔除工具执行消息及客户端调用，保留有效摘要及其后消息；被移除调用所依赖的 Responses 推理 ID 一并去除，推理内容和加密内容保留，未受影响的原生输出继续原样重放。预览、能力校验和发送遵循同一顺序。失败或取消后，token 展示从实际保留的 checkpoint 恢复，无法重算时清空旧展示。

模型协议或参数变更后，界面通过只读上下文接口重新投影当前 checkpoint，完成前隐藏旧估算、显示加载态并禁用手动压缩；模型窗口及压缩阈值立即更新，已展开的面板保持打开。只读投影复用 Agent 的指令、工具与附件组装，工具定义不依赖执行服务实例，不创建模型或运行图、不写 checkpoint、不启动 MCP 连接。运行中的预览使用当前实例已组装的产品配置；等待审批时按恢复请求会使用的当前提示词和已保存的运行能力配置重新投影。任务结束、重新打开或修改影响上下文的项目／应用配置时，按下一轮的当前配置重新预览，忽略已过时的异步结果。恢复运行不沿用旧实例的用量事件，持久化快照通过只读接口核对后再展示。子 Agent 仍保留自己的角色及父级能力约束。

## 表与正文引用

[CurrentStateSqliteSaver](../src/main/agent/currentStateSqliteSaver.ts) 实现框架 `BaseCheckpointSaver` 接口。

| 表 | 内容 |
| --- | --- |
| `current_state` | 每个 `(thread_id, checkpoint_ns)` 的唯一当前头：checkpoint ID、时间、格式、通道版本、已见版本和 metadata |
| `message_bodies` | 完整原生消息正文；`(thread_id, record_id)` 唯一，`record_id` 为规范化序列化内容哈希，原生 message ID 单独索引 |
| `state_messages` | 当前 messages 通道的顺序和正文引用 |
| `state_channels` | 其他通道的原生值和正文引用；messages 通道只存标记 |
| `pending_writes` | 等待框架归并的任务写入，按 checkpoint、task 和原生序号区分 |
| `message_references` | 通道、任务写入和产品活动对正文的持有关系，支持无引用正文清理 |

运行、审批、附件、队列、文件编辑及工具效果日志保留各自的产品表。消息索引、payload、模型活动和工具关联用于展示与定位，不另存模型历史。工具参数来自 AIMessage 的 `tool_calls`，结果来自 ToolMessage，按原生调用 ID 配对。

[消息编解码](../src/main/agent/currentStateMessageCodec.ts) 使用框架 JsonPlus 保留原生消息、供应商字段、用量和 artifact。ToolMessage 的 artifact 与消息同存，保留 Uint8Array、Map、Set 等类型；正文使用稳定键序编码。内部 `Send`、`__pregel_tasks` 和 pending writes 中的消息也使用正文引用，引用路径置于独立元数据，不向供应商正文插入标记。托管结果和效果日志通过 `saveReferencedValue` 共享正文。

同 ID 消息替换会更新当前引用，但旧任务仍引用的正文继续保留，直到引用消失。RemoveMessage 先由框架 reducer 处理，Saver 只保存归并后的顺序。这些执行依赖不构成永久历史。

## 提交与生命周期

`put`、`putWrites` 和独立完整结果提交共用串行队列。编码准备后，在 SQLite 事务中更新正文、当前头、引用及产品投影并清理；产品同步提交钩子失败时一起回滚。messages 按正文身份和位置增量更新，其他通道遵循框架 `newVersions`，移除通道同步删除。

`retainRun(runId, threadId)` 保留未结束运行所需的当前 tuple 和编码缓存。审批暂停只结束一次 stream，不结束产品 run，因此继续时可复用保留状态。成功、失败或取消完成收尾后调用 `releaseRun`；最后一个 run 释放时，清除该 thread 非当前头的临时 pending writes 和全部 namespace 内存缓存。新轮次从 SQLite 加载当前状态；请求非当前 checkpoint ID 返回缺失。

框架可能先调用 `putWrites`、再提交对应 checkpoint，因此不能按“非当前 ID”提前删除所有写入。尚未归并的结果、当前审批和已完成的并行工具结果必须保留；后续头提交和 run 释放负责清理。

缓存不冻结框架消息，而是保留独立副本并向框架返回可变对象。顶层、嵌套字段及 typed artifact 的原位修改会使相关正文缓存失效，已提交的旧引用保持原内容。大字符串可共享不可变值，但对象比较、读取副本和超大非消息通道仍有成本。

每个 namespace 只保存一个头，Saver 不推断任意子图 namespace 的业务寿命。当前产品子 Agent 使用独立 root thread；引入持续新增 namespace 的子图时，必须同时定义清理边界。

## 消息展示与维护

图片附件发送限制为每张 25 MiB；本地图片预览不设文件字节上限。消息缩略图按需生成，点击后由 Electron 的 `anas-image` 本地协议加载原文件，原图不再经 IPC 转为 Base64。发送后的附件仍从归档原文件预览。

Responses 流式生图结果通过 SDK 的响应转换生成标准图片块供界面展示，同时保留原生输出用于后续请求重放；展示图片不会在历史请求或 token 预算中重复计入。

[工具图片请求投影](../src/main/agent/toolImageProjection.ts) 在发送模型、计算上下文和压缩时，将已有后续正常模型响应的工具图片替换为占位说明。原始图片及 artifact 始终保留在消息正文中；未处理图片、工具文本、调用 ID 和用户附件不变。压缩与重试不能截断待处理图片；主子 Agent 各自依据消息状态判断。

编辑和重新生成从当前消息选择有效前缀。[AgentDatabase.replaceMessageHistory](../src/main/agent/agentDatabase.ts) 在一次事务中替换当前根状态、截断相关运行和活动、处理移除的子线程并创建新运行输入，不依赖旧 checkpoint fork。事务失败保留原状态；废弃附件进入持久清理队列，删除失败不撤销编辑或丢弃编辑草稿，重新打开会话时重试。资源清理完成后才删除待移除的会话库。

UI 按索引分页读取，run 活动初始窗口为末尾 100 条，先选窗口再解码正文。只合并连续分页区间，漏收实时事件形成的空段仍可补载；子 Agent 结果按需读取。模型轮次按数据库中的 run/Agent 索引计算，不随分页改变。同步解码用于界面投影，模型恢复仍用框架原生反序列化。

备份通过 [SQLite backup API](../src/main/agent/agentDatabaseBackup.ts) 分别快照 catalog 和登记的会话库，不直接复制可能存在 WAL 的主文件。复制期间数据结构变更、附件删除和文件恢复材料维护排队，后台 Agent 可继续提交完整消息。catalog 持久记录已接受的删除，备份排除这些会话及附件；恢复校验当前格式后，停止相关写入再切换数据目录。

## 性能与验证

增量正文存储消除每步复制完整历史的读写放大，不保证对话占用固定空间。真实消息、工具输出、附件和产品记录随工作量增长；顺序比较、引用清理、新轮次完整还原及 SDK 请求编码仍有开销。SQLite 写入与部分解码仍在 Electron 主进程，窗口响应性需通过构建后的应用验证。

- 存储、引用、事务及垃圾回收：[Saver 测试](../src/main/agent/currentStateSqliteSaver.test.ts)、[框架消息所有权](../src/main/agent/currentStateFrameworkOwnership.test.ts)。
- 恢复及生命周期：[并行审批恢复](../src/main/agent/parallelResumeRecovery.test.ts)、[嵌套中断](../src/main/agent/provisionalCheckpointRecovery.test.ts)、[checkpoint 生命周期](../src/main/agent/checkpointLifecycle.test.ts)、[手动压缩恢复](../src/main/agent/manualCompressionGraphRecovery.test.ts)。
- 展示和清理：[活动分页](../src/main/agent/agentActivityWindow.test.ts)、[历史附件清理](../src/main/agent/agentHistoryCleanup.test.ts)。
- [Electron 存储验收](../scripts/electron-current-storage.cjs)：`npm run test:e2e -- --storage-only` 使用隔离数据目录，在持续追加期间检查窗口交互、切换和分页；默认 1,000 条消息，可设 `ANAS_E2E_STORAGE_MESSAGES=10000` 检查 10,000 条规模。
- 启动响应性：`npm run test:e2e -- --startup-only` 检查环境探测及 Dev 统计未完成时的窗口交互。
- [运行中模型切换](../scripts/electron-model-selection.cjs)：`npm run test:e2e -- --model-selection-only` 使用隔离数据目录与本地模型服务，检查请求挂起时切换模型和预设、实时预算更新、后续请求参数及删除模型后的明确终止。
