import type { ChatModelStreamEvent } from '@langchain/core/language_models/event'
import type { AgentToolCallProgress } from '@shared/agentTypes'

const publishIntervalMs = 250

/** Native block-delta fields are snapshots (shallow merge), not JSON fragments.
 * Publish only reception metadata; Core owns complete argument assembly.
 */
export class ToolArgumentProgress {
  private readonly blocks = new Map<number, AgentToolCallProgress>()
  private timer?: ReturnType<typeof setTimeout>
  private dirty = false
  private disposed = false

  constructor(private readonly publish: (progress: AgentToolCallProgress[]) => void) {}

  accept(event: ChatModelStreamEvent): void {
    if (this.disposed) return
    const fields = event.event === 'content-block-delta'
      ? event.delta.type === 'block-delta' ? event.delta.fields : undefined
      : event.event === 'content-block-start' || event.event === 'content-block-finish'
        ? event.content
        : undefined
    if (!fields || !('index' in event)) return
    if (fields.type !== 'tool_call_chunk' && fields.type !== 'tool_call') return
    const record = fields as Record<string, unknown>
    const previous = this.blocks.get(event.index)
    // Atomic, non-streamed calls already use the normal completed-message path.
    if (!previous && fields.type !== 'tool_call_chunk') return
    const args = typeof record.args === 'string' ? record.args : undefined
    this.blocks.set(event.index, {
      index: event.index,
      callId: typeof record.id === 'string' && record.id ? record.id : previous?.callId,
      name: typeof record.name === 'string' && record.name ? record.name : previous?.name ?? '',
      characterCount: args?.length ?? previous?.characterCount ?? 0,
      complete: event.event === 'content-block-finish'
    })
    this.dirty = true
    if (!previous || event.event === 'content-block-finish') {
      this.flush()
      return
    }
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, publishIntervalMs)
  }

  flush(): void {
    if (!this.dirty) return
    this.dirty = false
    this.publish([...this.blocks.values()].sort((a, b) => a.index - b.index))
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.blocks.clear()
    this.dirty = false
  }
}
