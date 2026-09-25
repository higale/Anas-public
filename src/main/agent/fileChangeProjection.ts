import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'
import type { FileChangeOrigin, FileChangeQueryResult, FileChangeSegment } from '@shared/fileChanges'
import { filePatchDefinitionSchema, filePatchRecordMetadataSchema, patchTextHash } from '../filePatchRecord'
import { createTextPatch } from '../fileEditDiff'
import type { FileChangeEvent } from './fileChangeLedger'

export interface FileChangeSource {
  requestId: string
  operationId: string
  threadId: string
  actor: string
  definition: string
  metadata: string
  revision: number
  contentHashes: string[]
  events: FileChangeEvent[]
}
type Image = z.infer<typeof filePatchDefinitionSchema>['entries'][number]['before']
interface Fact { path: string; before: Image; after: Image; start?: number; end?: number; origin: FileChangeOrigin }
interface Segment { path: string; before: Image; after: Image; start?: number; end?: number; origins: FileChangeOrigin[]; continuity: FileChangeSegment['continuity'] }

function continuous(left: Image, right: Image): boolean {
  return left.target.canonicalPath === right.target.canonicalPath && left.hash === right.hash
    && left.target.exists === right.target.exists && isDeepStrictEqual(left.identity, right.identity)
    && isDeepStrictEqual(left.parent, right.parent)
}

export function projectFileChanges(input: {
  sources: FileChangeSource[]
  maxChars: number
  includePatch?: boolean
  baseDirectory: string
  filePath?: string
  partialPage: boolean
  content(hash: string): string
}): Pick<FileChangeQueryResult, 'segments' | 'issues' | 'patch' | 'patchTruncated'> {
  const facts: Fact[] = [], issues: FileChangeQueryResult['issues'] = []
  for (const source of input.sources) {
    try {
      const metadata = filePatchRecordMetadataSchema.parse(JSON.parse(source.metadata))
      const definition = filePatchDefinitionSchema.parse(JSON.parse(source.definition))
      if (metadata.requestId !== source.requestId || metadata.operationId !== source.operationId
        || metadata.revision !== source.revision
        || metadata.definitionHash !== patchTextHash(source.definition) || metadata.transaction.id !== source.operationId
        || metadata.transaction.entries.length !== definition.entries.length) throw new Error('History identity or definition mismatch.')
      const expectedHashes = new Set(definition.entries.flatMap((entry) => [entry.before.hash, entry.afterHash]).filter((hash) => hash !== null))
      if (expectedHashes.size !== source.contentHashes.length || source.contentHashes.some((hash) => !expectedHashes.has(hash))) {
        throw new Error('History snapshot references are incomplete.')
      }
      definition.entries.forEach((entry, index) => {
        const path = entry.before.target.canonicalPath
        if (input.filePath && path !== input.filePath) return
        const state = metadata.transaction.entries[index]
        if ((entry.before.hash === null) !== (entry.before.identity === null)
          || entry.before.target.exists !== (entry.before.hash !== null)
          || (state.after && (state.after.hash !== entry.afterHash || state.after.target.canonicalPath !== path
            || state.after.target.exists !== (state.after.hash !== null)))
          || (state.compensated && (state.compensated.hash !== entry.before.hash || state.compensated.target.canonicalPath !== path))) {
          throw new Error('History images disagree with their target or content identity.')
        }
        const origin: FileChangeOrigin = { runId: source.requestId, threadId: source.threadId, actor: source.actor,
          operationId: source.operationId, entryIndex: index, direction: definition.restores ? 'inverse' : 'forward' }
        const event = (phase: FileChangeEvent['phase'], image?: Image) => {
          const found = source.events.find((item) => item.entry_index === index && item.phase === phase)
          if (found && image && (!found.image_json || !isDeepStrictEqual(JSON.parse(found.image_json), image))) {
            throw new Error('History event disagrees with its confirmed image.')
          }
          return found?.observed === 0 ? found.sequence : undefined
        }
        if (state.after) {
          facts.push({ path, before: entry.before, after: state.after,
            start: event('intent'), end: event('applied', state.after), origin })
          if (state.compensated) {
            const start = event('restore_intent'), end = event('restored', state.compensated)
            if (start && end) facts.push({ path, before: state.after, after: state.compensated,
              start, end, origin: { ...origin, direction: 'compensation' } })
            else issues.push({ runId: source.requestId, operationId: source.operationId, path,
              reason: 'Restored state was observed without a proven reverse write; it is not counted as another edit.' })
          }
          if (state.state === 'conflict' || state.state === 'restoring') {
            issues.push({ runId: source.requestId, operationId: source.operationId, path, reason: `Recovery is ${state.state}; later effects are uncertain.` })
          }
        } else if (!['pending', 'restored'].includes(state.state)) {
          issues.push({ runId: source.requestId, operationId: source.operationId, path, reason: `Entry is ${state.state}; no confirmed postimage.` })
        }
      })
    } catch (error) {
      issues.push({ runId: source.requestId, operationId: source.operationId, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  const segments: Segment[] = []
  const paths = new Map<string, Fact[]>()
  for (const fact of facts) {
    const changes = paths.get(fact.path)
    if (changes) changes.push(fact)
    else paths.set(fact.path, [fact])
  }
  const unknownSource = issues.some((issue) => !issue.path)
  for (const [path, changes] of paths) {
    // One unknown effect makes this file's ordering uncertain. Do not silently
    // step around it and merge the remaining records across the missing event.
    const uncertain = unknownSource || issues.some((issue) => issue.path === path)
      || changes.some((fact) => !fact.start || !fact.end || fact.start >= fact.end)
    changes.sort((left, right) => (left.start ?? Number.MAX_SAFE_INTEGER) - (right.start ?? Number.MAX_SAFE_INTEGER))
    let current: Segment | undefined
    for (const fact of changes) {
      const ordered = current?.end !== undefined && fact.start !== undefined && current.end < fact.start
      const canMerge = current && !uncertain && ordered && continuous(current.after, fact.before)
      if (current && canMerge) {
        current.after = fact.after; current.end = fact.end; current.origins.push(fact.origin)
      } else {
        const continuity = uncertain || (current && !ordered) ? 'uncertain'
          : current ? 'external_change' : input.partialPage ? 'page_boundary' : 'recorded'
        current = { path, before: fact.before, after: fact.after, start: fact.start, end: fact.end, origins: [fact.origin], continuity }
        segments.push(current)
      }
    }
  }
  let remaining = input.maxChars
  const deadline = performance.now() + 250
  const projected: FileChangeSegment[] = segments.map((segment) => {
    const same = segment.before.hash === segment.after.hash && segment.before.target.exists === segment.after.target.exists
      && segment.before.identity?.mode === segment.after.identity?.mode
    const base = { beforeHash: segment.before.hash, afterHash: segment.after.hash, path: segment.path, origins: segment.origins, continuity: segment.continuity,
      beforeExists: segment.before.target.exists, afterExists: segment.after.target.exists, cancelledOut: same }
    if (input.includePatch === false) return { ...base, patch: '', patchTruncated: false }
    if (remaining <= 0 && !same) return { ...base, patch: '', patchTruncated: true }
    if (performance.now() >= deadline && !same) return { ...base, patch: '', patchTruncated: true, unavailableReason: 'Diff page computation budget exceeded; query one file.' }
    try {
      const before = segment.before.hash === null ? '' : input.content(segment.before.hash)
      const after = segment.after.hash === null ? '' : input.content(segment.after.hash)
      const result = createTextPatch({ path: segment.path, baseDirectory: input.baseDirectory, beforeText: before,
        afterText: after, beforeExists: base.beforeExists, afterExists: base.afterExists, maxChars: remaining,
        timeoutMs: Math.max(1, Math.min(100, deadline - performance.now())) })
      remaining -= result.patch.length + (result.patch.length ? 1 : 0)
      return { ...base, patch: result.patch, patchTruncated: result.patchTruncated,
        addedLines: result.addedLines, removedLines: result.removedLines,
        ...(result.patchUnavailableReason ? { unavailableReason: result.patchUnavailableReason } : {}) }
    } catch (error) {
      return { ...base, patch: '', patchTruncated: false, unavailableReason: error instanceof Error ? error.message : String(error) }
    }
  })
  return { segments: projected, issues, patch: projected.map((segment) => segment.patch).filter(Boolean).join('\n'),
    patchTruncated: projected.some((segment) => segment.patchTruncated) }
}
