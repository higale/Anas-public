import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeReviewResult } from './CodeReviewResult'
import type { CodeReviewPresentation } from '@shared/codeReview'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../chat/MarkdownText', () => ({ MarkdownText: ({ text }: { text: string }) => <p>{text}</p> }))
const review: CodeReviewPresentation = {
  snapshot: { id: 'a'.repeat(64), projectId: 'project', capturedAt: '2026-09-09T00:00:00.000Z', description: 'Frozen run changes',
    request: { kind: 'recorded', threadId: 'thread', runId: 'run', version: 'b'.repeat(64), target: 'recorded' }, limitations: [],
    files: [{ id: 'file-1', path: '/repo/one', patch: '-old\n+new', before: [{ start: 1, end: 1 }], after: [{ start: 1, end: 1 }] }] },
  report: { scope_id: 'a'.repeat(64), summary: 'Review summary', findings: [], limitations: ['No tests run'] }, locations: []
}
describe('code review presentation', () => {
  it('allows zero findings and keeps the exact captured scope inspectable', () => {
    render(<CodeReviewResult review={review} />)
    expect(screen.getByText('agent.review_no_findings')).toBeVisible()
    expect(screen.getByText('No tests run')).toBeVisible()
    expect(screen.getByText('agent.review_snapshot')).toBeVisible()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
  it('does not offer a location action for an unverified file or line', () => {
    const finding = { priority: 'P2' as const, title: 'Wrong result', file_id: 'file-1', side: 'after' as const, start_line: 1, end_line: 1,
      condition: 'A happens', impact: 'B fails', evidence: 'Proven by C' }
    render(<CodeReviewResult review={{ ...review, report: { ...review.report, findings: [finding, { ...finding, file_id: 'missing' }] },
      locations: [{ valid: true }, { valid: false, reason: 'Unknown file' }] }} />)
    expect(screen.getAllByText('agent.review_diff')).toHaveLength(1)
    expect(screen.getByText(/agent.review_invalid_location/)).toHaveTextContent('Unknown file')
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
