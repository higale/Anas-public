import { createHash } from 'node:crypto'
import { parsePatch } from 'diff'
import { codeReviewPriorityGuidance, codeReviewRequestSchema, codeReviewSnapshotSchema, type CodeReviewRequest, type CodeReviewSnapshot } from '@shared/codeReview'
import type { AgentDatabase } from './agentDatabase'
import { getProject } from '../projectStore'
import { queryGitChanges } from '../gitChanges'
import { readRoundContents } from './roundChanges'
import { createTextPatch } from '../fileEditDiff'

const maximumReviewBytes = 120_000
function snapshotId(value: Omit<CodeReviewSnapshot, 'id'>): string {
  return createHash('sha256').update(JSON.stringify(codeReviewSnapshotSchema.omit({ id: true }).parse(value))).digest('hex')
}

export function validateCodeReviewSnapshot(value: unknown): CodeReviewSnapshot {
  const snapshot = codeReviewSnapshotSchema.parse(value)
  const { id, ...content } = snapshot
  if (snapshotId(content) !== id) throw new Error('Code review snapshot identity is invalid.')
  if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > maximumReviewBytes) throw new Error('Code review snapshot exceeds its input budget.')
  return snapshot
}

export async function captureCodeReview(database: AgentDatabase, input: CodeReviewRequest, projectId: string): Promise<CodeReviewSnapshot> {
  const request = codeReviewRequestSchema.parse(input)
  const signal = AbortSignal.timeout(30_000)
  const files: Array<{ path: string; patch: string }> = [], limitations: string[] = []
  let description: string
  if (request.kind === 'recorded') {
    const run = database.getRun(request.runId), thread = database.getThread(request.threadId)
    if (!run || run.threadId !== request.threadId || thread?.projectId !== projectId) throw new Error('Recorded review scope does not belong to the selected project and conversation.')
    const result = database.fileChanges.queryRoundFiles({ runId: request.runId, filePath: request.filePath, version: request.version, limit: 100 })
    if (result.hasMore) throw new Error('Review scope is too large. Select a single file or a smaller scope.')
    if (result.pendingRunIds.length) throw new Error('Wait for the selected run and its subagents to settle before starting a review.')
    for (const file of result.files) {
      if (file.unavailableReason) throw new Error('A selected recorded diff is unavailable or incomplete. Select another scope.')
      const contents = await readRoundContents(database.fileChanges, { ...request, filePath: file.path }, signal)
      if (contents.status !== 'ready') throw new Error('A selected recorded diff is unavailable or incomplete. Select another scope.')
      const patch = createTextPatch({ path: file.path, beforeText: contents.before, afterText: contents.after,
        beforeExists: contents.beforeExists, afterExists: contents.afterExists, maxChars: 40_000 })
      if (!patch.patchAvailable || patch.patchTruncated) throw new Error('Review scope is too large. Select a single file or a smaller scope.')
      if (patch.patch) files.push({ path: file.path, patch: patch.patch })
      if (Buffer.byteLength(JSON.stringify(files), 'utf8') > maximumReviewBytes) throw new Error('Review scope exceeds its input budget. Select a single file or a smaller scope.')
      if (file.continuity !== 'recorded') limitations.push(`${file.path}: ${file.continuity}; endpoint differences may include external changes.`)
    }
    limitations.push(...result.issues.map((issue) => `${issue.path ?? issue.operationId ?? request.runId}: ${issue.reason}`))
    description = `File changes from run ${request.runId} and its actual descendants: first recorded preimage → ${request.target === 'current' ? 'current on-disk file at capture time' : 'last recorded result'}. Only files recorded in this run are included.`
    if (request.target === 'current') limitations.push('Current on-disk files may include later runs or manual edits; these differences are not attributed solely to the selected run.')

  } else {
    if (request.projectId !== projectId) throw new Error('Git review scope belongs to another project.')
    const project = await getProject(projectId)
    if (project.kind !== 'workspace' || !project.sourceFolders.includes(request.sourceFolder)) throw new Error('Git review source is not an actual project source folder.')
    let after = 0, hasMore = true
    description = ''
    do {
      const result = await queryGitChanges({ ...request, after, limit: 20 }, signal)
      description = request.scope !== 'baseline'
        ? `Git working changes in ${result.sourceFolder}: ${request.scope === 'unstaged' ? 'index' : result.baseline ?? 'unborn HEAD'} → ${request.scope === 'staged' ? 'index' : 'working tree'}. These are not attributed to the Agent.`
        : `Git committed changes in ${result.sourceFolder}: ${result.baseline} → ${result.head}. No uncommitted changes are included.`
      for (const file of result.files) {
        if (file.patchTruncated || file.unavailableReason) throw new Error('A selected Git diff is unavailable or too large. Select a smaller scope.')
        files.push({ path: file.path, patch: file.patch })
      }
      if (files.length > 100 || Buffer.byteLength(JSON.stringify(files), 'utf8') > maximumReviewBytes) throw new Error('Review scope exceeds its input budget. Select a single file or a smaller scope.')
      hasMore = result.hasMore
      if (hasMore) {
        if (result.nextAfter === undefined || result.nextAfter <= after) throw new Error('Git review pagination did not advance.')
        after = result.nextAfter
      }
    } while (hasMore)
  }
  if (!files.length) throw new Error('The selected scope contains no reviewable changes.')
  const value: Omit<CodeReviewSnapshot, 'id'> = {
    request, projectId, capturedAt: new Date().toISOString(), description, limitations,
    files: files.map((file, index) => {
      const hunks = parsePatch(file.patch).flatMap((item) => item.hunks)
      if (!hunks.length) limitations.push(`${file.path}: no text hunks are available; line locations cannot be verified.`)
      return { ...file, id: `file-${index + 1}`,
        before: hunks.filter((hunk) => hunk.oldLines > 0).map((hunk) => ({ start: hunk.oldStart, end: hunk.oldStart + hunk.oldLines - 1 })),
        after: hunks.filter((hunk) => hunk.newLines > 0).map((hunk) => ({ start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 })) }
    })
  }
  return validateCodeReviewSnapshot({ id: snapshotId(value), ...value })
}

export function codeReviewPrompt(snapshot: CodeReviewSnapshot): string {
  return `Review the captured code changes below. This is a review request, not a request to fix, edit, commit or push anything.
Use the existing tools only for necessary investigation and non-mutating verification, within the current capabilities and access mode. Do not start a repair workflow.
Report actionable defects introduced by these changes, with concrete triggering conditions, impact and evidence. Do not invent findings to meet a quota; zero findings is valid. Separate missing validation and uncertainty from confirmed defects. Do not report style preferences alone.
Check each before/after example for consistent reasoning. Do not report the same underlying defect more than once. If an input is not established as part of the intended contract, describe that uncertainty in limitations instead of asserting a regression.
Return the required structured report with scope_id ${snapshot.id}. Use the exact file_id shown below, and before/after line ranges from that file's captured diff. Never invent a current-disk location for historical or uncertain changes.
Use the smallest complete line range that pinpoints the defect; avoid covering a whole function when one expression identifies it.
${codeReviewPriorityGuidance}
If current files differ from the snapshot, clearly report this limitation and do not silently expand or change the review scope. Follow the conversation's language when presenting the report.

Scope: ${snapshot.description}
Known limitations: ${JSON.stringify(snapshot.limitations)}

${snapshot.files.map((file) => `file_id: ${file.id}\npath: ${file.path}\n${file.patch}`).join('\n\n')}`
}
