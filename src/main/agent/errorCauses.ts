/** Framework middleware and provider errors can wrap the original failure. */
export function errorCauses(error: unknown): object[] {
  const causes: object[] = []
  const seen = new Set<unknown>()
  const pending = [error]
  while (pending.length > 0) {
    const current = pending.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    causes.push(current)
    seen.add(current)
    const record = current as { cause?: unknown; error?: unknown }
    pending.push(record.cause, record.error)
  }
  return causes
}
