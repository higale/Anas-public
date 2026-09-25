import { z } from 'zod/v3'

export const terminalSizeSchema = z.object({
  columns: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(500)
}).strict()

export const terminalActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().min(1).max(16_000) }).strict(),
  z.object({ type: z.literal('key'), key: z.enum(['enter', 'tab', 'escape', 'backspace', 'up', 'down', 'left', 'right', 'ctrl_c']) }).strict(),
  z.object({ type: z.literal('eof') }).strict(),
  z.object({ type: z.literal('resize'), ...terminalSizeSchema.shape }).strict()
])

export type TerminalSize = z.infer<typeof terminalSizeSchema>
export type TerminalAction = z.infer<typeof terminalActionSchema>

export function terminalInput(action: Exclude<TerminalAction, { type: 'resize' }>, platform = process.platform): string {
  if (action.type === 'text') return action.text
  // This sends the platform's conventional EOF key, not a pipe half-close.
  // Raw-mode/full-screen applications may interpret it differently.
  if (action.type === 'eof') return platform === 'win32' ? '\x1a\r' : '\x04'
  return { enter: '\r', tab: '\t', escape: '\x1b', backspace: '\x7f', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', ctrl_c: '\x03' }[action.key]
}
