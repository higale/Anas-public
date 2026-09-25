import { formatPatch, structuredPatch } from 'diff'
import type { StructuredPatch } from 'diff'
import { isAbsolute, relative, resolve } from 'node:path'

export const patchFormat = 'git_unified'
export const defaultPatchMaxChars = 12_000
export const defaultRequestPatchMaxChars = 20_000
export const maxPatchMaxChars = 40_000
export const maxPatchInputBytes = 1_000_000
const patchContextLines = 3
const maxPatchEditLength = 80_000

export interface TextPatchResult {
  patchAvailable: boolean
  patchFormat: typeof patchFormat
  patch: string
  patchTruncated: boolean
  patchUnavailableReason?: string
  addedLines?: number
  removedLines?: number
}

function normalizePatchPath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function displayPathForPatch(path: string, baseDirectory = process.cwd()): string {
  const absolutePath = resolve(baseDirectory, path)
  const relativePath = relative(baseDirectory, absolutePath)
  if (relativePath && !/^\.\.(?:[/\\]|$)/.test(relativePath) && !isAbsolute(relativePath)) return normalizePatchPath(relativePath)
  return normalizePatchPath(absolutePath)
}

function boundedPatch(patch: string, maxChars: number): { patch: string; patchTruncated: boolean } {
  if (patch.length <= maxChars) return { patch, patchTruncated: false }
  return { patch: '', patchTruncated: true }
}

export function createTextPatch(input: {
  path: string
  baseDirectory?: string
  beforeText: string
  afterText: string
  beforeExists: boolean
  afterExists?: boolean
  maxChars?: number
  timeoutMs?: number
}): TextPatchResult {
  const maxChars = input.maxChars ?? defaultPatchMaxChars
  const beforeBytes = Buffer.byteLength(input.beforeText, 'utf8')
  const afterBytes = Buffer.byteLength(input.afterText, 'utf8')
  if (beforeBytes > maxPatchInputBytes || afterBytes > maxPatchInputBytes) {
    return {
      patchAvailable: false,
      patchFormat,
      patch: '',
      patchTruncated: false,
      patchUnavailableReason: `patch input is too large (${Math.max(beforeBytes, afterBytes)} bytes, max ${maxPatchInputBytes})`
    }
  }

  const beforeExists = input.beforeExists
  const afterExists = input.afterExists !== false
  if (input.beforeText === input.afterText && beforeExists === afterExists) {
    return { patchAvailable: true, patchFormat, patch: '', patchTruncated: false, addedLines: 0, removedLines: 0 }
  }

  const displayPath = displayPathForPatch(input.path, input.baseDirectory)
  const oldFileName = beforeExists ? `a/${displayPath}` : '/dev/null'
  const newFileName = afterExists ? `b/${displayPath}` : '/dev/null'
  const patch = structuredPatch(oldFileName, newFileName, input.beforeText, input.afterText, '', '', {
    context: patchContextLines,
    maxEditLength: maxPatchEditLength,
    timeout: input.timeoutMs ?? 100
  }) as StructuredPatch | undefined

  if (!patch) {
    return {
      patchAvailable: false,
      patchFormat,
      patch: '',
      patchTruncated: false,
      patchUnavailableReason: 'patch diff computation limit exceeded'
    }
  }

  patch.isGit = true
  if (!beforeExists) patch.isCreate = true
  if (!afterExists) patch.isDelete = true

  return {
    patchAvailable: true,
    patchFormat,
    addedLines: patch.hunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.startsWith('+')).length, 0),
    removedLines: patch.hunks.reduce((count, hunk) => count + hunk.lines.filter((line) => line.startsWith('-')).length, 0),
    ...boundedPatch(formatPatch(patch), maxChars)
  }
}
