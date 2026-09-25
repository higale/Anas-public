export function clampIntegerInput(value: string, min: number, max: number): number {
  const parsed = Math.floor(Number(value))
  if (!Number.isFinite(parsed)) return min
  return Math.min(max, Math.max(min, parsed))
}
