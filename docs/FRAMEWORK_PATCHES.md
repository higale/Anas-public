# 框架与 UI 依赖补丁

补丁位于 [patches/](../patches)，直接修改锁文件指定版本的发布代码，ESM 与 CommonJS 同时覆盖。LangChain、LangGraph 和 Deep Agents 仍负责模型循环、消息、checkpoint、重试与 interrupt。

## 当前补丁

| 依赖版本 | 修复范围 | 回归入口 |
| --- | --- | --- |
| `langchain@1.5.11` | 结构化报告重试、HITL 批次结果配对、工具路由 | [结构化报告](../src/main/agent/structuredResponseRouting.test.ts)、[工具批次](../src/main/agent/toolBatchRouting.test.ts)、[审批](../src/main/agent/toolApprovalMiddleware.test.ts)、[补丁授权](../src/main/agent/patchAuthorization.test.ts)、[Agent 工厂](../src/main/agent/agentFactory.test.ts) |
| `@langchain/anthropic@1.5.10` | 流式累计用量 | [用量测试](../src/main/agent/anthropicUsage.test.ts) |
| `deepagents@1.13.0` | 显式摘要模型优先级 | [摘要模型测试](../src/main/agent/summarizationModelSelection.test.ts) |
| `@radix-ui/react-dismissable-layer@1.1.19` | 嵌套弹层的 Escape 分发 | [项目预览 E2E](../scripts/electron-project-previews.cjs) |

### 结构化报告与工具路由

结构化报告校验失败时，原 AgentNode 的 Command 直接跳转模型，而既有静态边仍进入 afterModel 钩子，可能导致并发更新，也会跳过下一轮 beforeModel 的预算和调用上限检查。补丁只提交错误消息，让正常图路由完成后置钩子，再从循环入口重试。多份结构化报告被拒绝时，每个调用均得到对应结果。

HITL 批次有拒绝项时，补丁保留完整调用及顺序，为其余未执行项补齐结果，维持框架“有拒绝则本批不执行”的行为。审批和任务列表检查只处理尚未回答的调用；整批已回答时仍经过剩余 afterModel 和下一轮 beforeModel。结果只在当前 AIMessage 之后配对，历史轮次的同名调用 ID 不会抑制新调用；v1 ToolNode 与原生路由使用相同范围。

### Anthropic 累计用量

部分兼容供应商在 `message_start` 返回零输入，到 `message_delta` 才报告实际输入和缓存读取；重复累计输出也不能逐次相加。补丁为每条流维护累计快照：后到字段更新原值，省略字段保留已知值。原生事件流输出快照，AIMessageChunk 输出与上一快照之差，使框架拼接得到正确累计值。`streamUsage` 关闭时仍不返回用量；补丁不推断供应商未返回的用量或实际计费。

### 显式摘要模型

Deep Agents 原摘要中间件优先使用当前请求模型，即使已配置专用摘要模型。补丁使显式配置优先；未配置时保留原有请求模型和默认解析行为。

### 嵌套弹层的 Escape

Radix 原实现按渲染时的最高层状态管理 Escape 监听，嵌套弹层显示后、effect 更新前，底层监听仍可能关闭项目设置并丢失草稿。补丁在键盘事件发生时查询 Radix 的当前层集合，只允许最高层处理 Escape；焦点和弹窗生命周期仍由 Radix 管理。

## 安装与升级

`npm ci` 的 postinstall 首先执行 `patch-package --error-on-fail`，补丁失败即中止安装，随后才准备 Electron 和原生模块。开发、测试、构建和打包均使用应用补丁后的依赖；编码评测的源码指纹也包含补丁文件。

升级相关依赖时，先用未应用补丁的目标版本运行对应回归，确认哪些修复已进入上游。删除已不需要的补丁；仍需修复的部分按目标版本重新生成并检查，不能忽略补丁失败或强行套用旧差异。当前本地生成命令：

```sh
npx patch-package langchain @langchain/anthropic deepagents @radix-ui/react-dismissable-layer
```

生成后验证干净安装、相关测试和构建。项目预览测试由 `npm run test:e2e` 调用；补丁版本必须与锁文件中实际安装版本一致。
