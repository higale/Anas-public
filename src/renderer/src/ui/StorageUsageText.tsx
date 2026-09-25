import { useTranslation } from 'react-i18next'
import type { StorageUsageValue } from '@shared/types'
import { formatBytes } from './formatBytes'

export function StorageUsageText({
  loading,
  usage
}: {
  loading: boolean
  usage?: StorageUsageValue
}) {
  const { t } = useTranslation()
  if (!usage && !loading) return null
  return (
    <small className="ui-list-item-meta" aria-live="polite">
      {usage
        ? `${usage.approximate ? '≈ ' : ''}${formatBytes(usage.totalBytes)}`
        : t('common.loading')}
    </small>
  )
}
