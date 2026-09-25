import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CodeReviewRequest } from '@shared/codeReview'
import { notice } from '../notice'

export function CodeReviewButton({ request, disabled, onReview }: {
  request?: CodeReviewRequest; disabled?: boolean; onReview(request: CodeReviewRequest): Promise<void>
}) {
  const { t } = useTranslation(), busyRef = useRef(false), [busy, setBusy] = useState(false)
  return <button type="button" className="ui-button ui-button-compact" disabled={disabled || busy || !request} onClick={() => {
    if (!request || busyRef.current) return
    busyRef.current = true; setBusy(true)
    void onReview(request).catch((error: unknown) => notice.error(error instanceof Error ? error.message : String(error)))
      .finally(() => { busyRef.current = false; setBusy(false) })
  }}>{t(busy ? 'common.loading' : 'agent.review_start')}</button>
}
