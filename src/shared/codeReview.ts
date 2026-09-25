import { z } from 'zod/v3'

const version = z.string().regex(/^[a-f0-9]{64}$/)
const path = z.string().min(1).max(32768)
export const codeReviewRequestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('recorded'), threadId: z.string().min(1).max(256), runId: z.string().min(1).max(256),
    filePath: path.optional(), version, target: z.enum(['recorded', 'current']) }).strict(),
  z.object({ kind: z.literal('git'), projectId: z.string().min(1).max(256), sourceFolder: path,
    scope: z.enum(['workspace', 'baseline', 'staged', 'unstaged']), baseline: z.string().min(1).max(1024).optional(),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
    filePath: path.optional(), version }).strict()
])
export type CodeReviewRequest = z.infer<typeof codeReviewRequestSchema>

const lineRange = z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict()
export const codeReviewSnapshotSchema = z.object({
  id: version,
  request: codeReviewRequestSchema,
  projectId: z.string().min(1).max(256),
  capturedAt: z.string().datetime(),
  description: z.string().min(1).max(4096),
  files: z.array(z.object({
    id: z.string().min(1).max(64), path, patch: z.string().max(120_000),
    before: z.array(lineRange).max(5000), after: z.array(lineRange).max(5000)
  }).strict()).min(1).max(100),
  limitations: z.array(z.string().max(4096)).max(100)
}).strict()
export type CodeReviewSnapshot = z.infer<typeof codeReviewSnapshotSchema>

// Product-facing projection of docs/SECURITY_MODEL.md section 8.
export const codeReviewPriorityGuidance = [
  'Choose priority from demonstrated impact, not hypothetical callers or an exported API alone.',
  'P0: release-blocking, broad irreversible loss of host files or core data.',
  'P1: irreversible data loss, unintended cross-target changes, inconsistent persisted state, or loss of core functionality.',
  'P2: bounded functional correctness, resource, reliability, accessibility, or recovery defects.',
  'P3: minor maintainability, diagnostic, dependency hygiene, or rule-consistency defects.',
  'An isolated edge-case failure without evidence of wider damage is P2. Missing callers or tests is a limitation, not evidence for higher priority.'
].join('\n')

export const codeReviewReportSchema = z.object({
  scope_id: version,
  summary: z.string().min(1).max(4000),
  findings: z.array(z.object({
    priority: z.enum(['P0', 'P1', 'P2', 'P3']).describe(codeReviewPriorityGuidance), title: z.string().min(1).max(300),
    file_id: z.string().min(1).max(64), side: z.enum(['before', 'after']),
    start_line: z.number().int().positive().max(100_000_000), end_line: z.number().int().positive().max(100_000_000),
    condition: z.string().min(1).max(3000), impact: z.string().min(1).max(3000), evidence: z.string().min(1).max(4000)
  }).strict()).max(50),
  limitations: z.array(z.string().min(1).max(2000)).max(20)
}).strict()
export type CodeReviewReport = z.infer<typeof codeReviewReportSchema>
export interface CodeReviewPresentation {
  snapshot: CodeReviewSnapshot
  report: CodeReviewReport
  locations: Array<{ valid: boolean; reason?: string }>
}

export function reviewLocations(snapshot: CodeReviewSnapshot, report: CodeReviewReport): CodeReviewPresentation['locations'] {
  return report.findings.map((finding) => {
    if (report.scope_id !== snapshot.id) return { valid: false, reason: 'Review scope does not match the captured changes.' }
    const file = snapshot.files.find((entry) => entry.id === finding.file_id)
    if (!file) return { valid: false, reason: 'File is not part of this review scope.' }
    if (finding.end_line < finding.start_line || !file[finding.side].some((range) => finding.start_line >= range.start && finding.end_line <= range.end)) {
      return { valid: false, reason: 'Line range is outside the captured diff; no verified location is available.' }
    }
    return { valid: true }
  })
}
