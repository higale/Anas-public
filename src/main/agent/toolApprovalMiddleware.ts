import { AsyncLocalStorage } from 'node:async_hooks'
import { isGraphBubbleUp } from '@langchain/langgraph'
import { ToolMessage } from '@langchain/core/messages'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { createMiddleware, humanInTheLoopMiddleware, type InterruptOnConfig } from 'langchain'
import { patchAuthorizationFor, patchAuthorizationStateSchema } from './patchAuthorization'
import { projectRulesSchema } from './projectRules'
import { shellAuthorizationFor, shellAuthorizationStateSchema } from './shellAuthorization'
import { pendingModelToolCalls, validateAgentToolInput } from './toolInputErrors'

/** Keep native interrupts and checkpoint explicit human grants separately from
 * Shell arguments. Structured file tools still persist canonical path binding. */
export function createToolApprovalMiddleware(interruptOn: Record<string, InterruptOnConfig>, tools: readonly StructuredToolInterface[]) {
  const available = new Map(tools.map(tool => [tool.name, tool]))
  const batch = new AsyncLocalStorage<{ errors: ToolMessage[]; reviewed: Set<string> }>()
  const middleware = humanInTheLoopMiddleware({ interruptOn: Object.fromEntries(
    Object.entries(interruptOn).map(([name, config]) => [name, { ...config,
      when: async (request: Parameters<NonNullable<InterruptOnConfig['when']>>[0]) => {
        try {
          const tool = available.get(name)
          if (tool) await validateAgentToolInput(tool, request.toolCall.args)
          const needsReview = config.when ? await config.when(request) : true
          if (needsReview && request.toolCall.id) batch.getStore()?.reviewed.add(request.toolCall.id)
          return needsReview
        } catch (error) {
          if (isGraphBubbleUp(error)) throw error
          request.runtime.signal?.throwIfAborted()
          const errors = batch.getStore()?.errors
          if (!errors || !request.toolCall.id) throw error
          errors.push(new ToolMessage({ tool_call_id: request.toolCall.id, name: request.toolCall.name,
            status: 'error', content: `NOT EXECUTED: ${String(error)}. Correct the arguments and decide again.` }))
          // This call already has an error result in the same checkpoint update;
          // the native router will not dispatch it as an approved operation.
          return false
        }
      }
    }])
  ) })
  const afterModel = middleware.afterModel!
  const hook = typeof afterModel === 'function' ? afterModel : afterModel.hook
  return createMiddleware({
    ...middleware,
    // Framework hooks receive only built-in state and explicitly declared
    // channels. Approval predicates need both preflight decisions at replay.
    stateSchema: patchAuthorizationStateSchema.extend(shellAuthorizationStateSchema.shape)
      .extend({ anasProjectRules: projectRulesSchema.optional() }),
    afterModel: {
      ...(typeof afterModel === 'function' ? {} : afterModel),
      hook: async (state, runtime) => {
        const { message, answered: previouslyAnswered } = pendingModelToolCalls(state.messages)
        const before = JSON.stringify(message?.tool_calls)
        const errors: ToolMessage[] = []
        const reviewed = new Set<string>()
        const result = await batch.run({ errors, reviewed }, () => hook(state, runtime))
        // Reaching this point means native HITL has processed the decisions.
        // Only surviving, unanswered, exact calls that actually went through
        // review get a grant; an access-mode exemption is never human approval.
        const answered = new Set([...previouslyAnswered, ...[...(result?.messages ?? []).filter(ToolMessage.isInstance), ...errors]
          .map((item) => item.tool_call_id)])
        const parsed = patchAuthorizationStateSchema.safeParse(state)
        const receipt = parsed.success ? parsed.data.anasPatchAuthorization : undefined
        const approval = receipt && reviewed.size ? { anasPatchAuthorization: { ...receipt,
          calls: receipt.calls.map((item) => ({ ...item, humanApproved: reviewed.has(item.id) && !answered.has(item.id)
            && !!message?.tool_calls?.some((call) => call.id === item.id && patchAuthorizationFor(state, call)?.inputHash === item.inputHash) }))
        } } : {}
        const shellParsed = shellAuthorizationStateSchema.safeParse(state)
        const shellReceipt = shellParsed.success ? shellParsed.data.anasShellAuthorization : undefined
        const shellApproval = shellReceipt && reviewed.size ? { anasShellAuthorization: { ...shellReceipt,
          calls: shellReceipt.calls.map((item) => ({ ...item, humanApproved: reviewed.has(item.id) && !answered.has(item.id)
            && !!message?.tool_calls?.some((call) => call.id === item.id
              && shellAuthorizationFor(state, call, shellReceipt.runId)?.inputHash === item.inputHash) }))
        } } : {}
        if (errors.length) {
          // A native batch rejection can also withhold a call that failed this
          // predicate. Preserve its specific diagnostic as its only result.
          const errorIds = new Set(errors.map(item => item.tool_call_id))
          const messages = [...(result?.messages ?? (message ? [message] : [])).filter(item =>
            !ToolMessage.isInstance(item) || !errorIds.has(item.tool_call_id)), ...errors]
          return { ...result, ...approval, ...shellApproval, messages }
        }
        if (result) return { ...result, ...approval, ...shellApproval }
        if (message && JSON.stringify(message.tool_calls) !== before) return { messages: [message] }
      }
    }
  })
}
