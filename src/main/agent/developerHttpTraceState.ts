let enabled = false

export function isDeveloperHttpTraceEnabled(): boolean {
  return enabled
}

export function setDeveloperHttpTraceEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid developer HTTP trace state.')
  enabled = value
  return enabled
}
