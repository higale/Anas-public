import { createHash } from 'node:crypto'

const interruptMetadataKey = 'anasSubagentApproval'
const responseGenerationKey = '__anas_interrupt_generation'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  const current = record(value)
  if (!current) return value
  return Object.fromEntries(
    Object.keys(current).sort().map((key) => [key, canonicalValue(current[key])])
  )
}

export function createApprovalGeneration(input: {
  runId: string
  checkpointId: string
  interrupts: ReadonlyArray<{
    interruptId: string
    resumeCount: number
    value: unknown
  }>
}): string {
  const interrupts = input.interrupts
    .map((interrupt) => ({
      ...interrupt,
      value: canonicalValue(interrupt.value)
    }))
    .sort((left, right) => left.interruptId.localeCompare(right.interruptId))
  return createHash('sha256').update(JSON.stringify([
    'anas-approval-generation-v1',
    input.runId,
    input.checkpointId,
    interrupts
  ])).digest('hex')
}

export function subagentApprovalInterruptMetadata(generation: string): {
  anasSubagentApproval: { generation: string }
} {
  return { [interruptMetadataKey]: { generation } }
}

export function subagentApprovalGenerationFromInterrupt(value: unknown): string | undefined {
  const metadata = record(record(value)?.[interruptMetadataKey])
  return typeof metadata?.generation === 'string' && metadata.generation
    ? metadata.generation
    : undefined
}

export function tagSubagentApprovalResponse(
  response: unknown,
  generation: string | undefined
): unknown {
  if (!generation) return response
  const current = record(response)
  if (!current) throw new Error('A subagent approval response must be an object.')
  return { ...current, [responseGenerationKey]: generation }
}

export function subagentApprovalGenerationFromResponse(value: unknown): string | undefined {
  const generation = record(value)?.[responseGenerationKey]
  return typeof generation === 'string' && generation ? generation : undefined
}
