import { dialog } from 'electron'
import { applicationName } from '@shared/appMetadata'

interface StartupFailureCopy {
  title: string
  content: string
}

function startupFailureReason(reason: unknown, chinese: boolean): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim()
  if (typeof reason === 'string' && reason.trim()) return reason.trim()
  return chinese ? '未知启动错误。' : 'Unknown startup error.'
}

export function startupFailureCopy(reason: unknown, locale: string): StartupFailureCopy {
  const chinese = locale.toLowerCase().startsWith('zh')
  const detail = startupFailureReason(reason, chinese)
  return chinese
    ? {
        title: `${applicationName} 启动失败`,
        content: `${applicationName} 无法启动。\n\n${detail}\n\n请检查错误信息和数据目录，然后重试。`
      }
    : {
        title: `${applicationName} failed to start`,
        content: `${applicationName} could not start.\n\n${detail}\n\nCheck the error and data directory, then try again.`
      }
}

export function reportStartupFailure(
  reason: unknown,
  exitApplication: (exitCode: number) => void,
  locale?: string
): void {
  console.error(reason)
  try {
    let resolvedLocale = locale
    if (!resolvedLocale) {
      try {
        resolvedLocale = Intl.DateTimeFormat().resolvedOptions().locale
      } catch {
        resolvedLocale = 'en-US'
      }
    }
    const copy = startupFailureCopy(reason, resolvedLocale)
    dialog.showErrorBox(copy.title, copy.content)
  } catch (dialogReason) {
    console.error('Failed to show the startup error dialog.', dialogReason)
  } finally {
    exitApplication(1)
  }
}
