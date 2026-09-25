import { useTranslation } from 'react-i18next'
import type { CodeReviewPresentation } from '@shared/codeReview'
import { MarkdownText } from '../chat/MarkdownText'

export function CodeReviewResult({ review }: { review: CodeReviewPresentation }) {
  const { t } = useTranslation()
  return <section className="ui-stack ui-stack-tight" aria-label={t('agent.review_title')}>
    <MarkdownText text={review.report.summary} />
    <p className="ui-field-hint">{review.snapshot.description}</p>
    {review.report.findings.length === 0 && <p>{t('agent.review_no_findings')}</p>}
    {review.report.findings.map((finding, index) => {
      const file = review.snapshot.files.find((entry) => entry.id === finding.file_id)
      const location = review.locations[index]
      return <section className="ui-section ui-page-section ui-stack ui-stack-tight" key={index}>
        <strong>[{finding.priority}] {finding.title}</strong>
        <p>{file?.path ?? finding.file_id} · {t(finding.side === 'before' ? 'agent.review_before' : 'agent.review_after')}:{finding.start_line}–{finding.end_line}</p>
        <p><strong>{t('agent.review_condition')}: </strong>{finding.condition}</p>
        <p><strong>{t('agent.review_impact')}: </strong>{finding.impact}</p>
        <p><strong>{t('agent.review_evidence')}: </strong>{finding.evidence}</p>
        {location?.valid && file ? <details className="ui-disclosure">
          <summary>{t('agent.review_diff')}</summary>
          <pre className="ui-code-block" data-native-context-menu="text">{file.patch}</pre>
        </details> : <p className="ui-field-hint">{t('agent.review_invalid_location')} {location?.reason}</p>}
      </section>
    })}
    {[...review.snapshot.limitations, ...review.report.limitations].map((limitation, index) => <p className="ui-field-hint" key={index}>{limitation}</p>)}
    <details className="ui-disclosure">
      <summary>{t('agent.review_snapshot')}</summary>
      <div className="ui-stack ui-stack-tight">
        <p className="ui-field-hint">{review.snapshot.capturedAt} · {review.snapshot.id}</p>
        {review.snapshot.files.map((file) => <details className="ui-disclosure" key={file.id}>
          <summary>{file.path} · {file.id}</summary><pre className="ui-code-block" data-native-context-menu="text">{file.patch}</pre>
        </details>)}
      </div>
    </details>
  </section>
}
