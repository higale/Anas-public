import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Bot } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppBuildInfo } from '@shared/types'
import { applicationLicenseUrl, applicationRepositoryUrl } from '@shared/appMetadata'
import { formatBuildTime } from '../buildInfo'

export function AboutDialog({ open, buildInfo, iconDataUri, onClose }: {
  open: boolean
  buildInfo?: AppBuildInfo
  iconDataUri?: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const buildTime = buildInfo?.environment === 'production' ? formatBuildTime(buildInfo.builtAt) : ''
  return (
    <AlertDialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="ui-backdrop" onClick={onClose} />
        <AlertDialog.Content className="ui-dialog ui-dialog-compact ui-dialog-narrow ui-dialog-centered ui-popover">
          <div className="ui-row ui-row-lg">
            <div className="ui-icon-box ui-icon-box-lg" aria-hidden="true">
              {iconDataUri ? <img src={iconDataUri} alt="" draggable={false} /> : <Bot size={30} />}
            </div>
            <div>
              <AlertDialog.Title asChild>
                <h2 className="ui-dialog-title">Anas</h2>
              </AlertDialog.Title>
              <div className="ui-subtitle-sm">Ananas</div>
            </div>
          </div>
          <AlertDialog.Description className="ui-dialog-description">
            {t('settings.about_description')}
          </AlertDialog.Description>
          <div className="ui-row-between">
            <a className="ui-text-link" href={applicationRepositoryUrl} target="_blank" rel="noreferrer">
              GitHub · higale/Anas-public
            </a>
            <a className="ui-text-link" href={applicationLicenseUrl} target="_blank" rel="noreferrer">
              MIT License
            </a>
          </div>
          <div className="ui-row-between ui-divider-top ui-meta-row">
            <span className="ui-copy-stack">
              <span>Version {buildInfo?.version ?? '-'}</span>
              {buildInfo?.environment === 'development'
                ? <span>Development</span>
                : buildTime && <time dateTime={buildInfo?.builtAt}>Built {buildTime}</time>}
            </span>
            <span>© gale</span>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
