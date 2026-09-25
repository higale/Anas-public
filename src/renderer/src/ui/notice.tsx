import { Toaster, toast } from 'sonner'
import type { ExternalToast } from 'sonner'
import { DismissableLayerBranch } from '@radix-ui/react-dismissable-layer'
import { useTranslation } from 'react-i18next'

type NoticeOptions = Pick<ExternalToast, 'description' | 'duration' | 'id'>
type NoticeTheme = 'light' | 'dark'

const defaultDuration = 3200
const errorDuration = 5600

function options(input?: NoticeOptions, duration = defaultDuration): ExternalToast {
  return {
    duration,
    ...input
  }
}

export const notice = {
  success(message: string, input?: NoticeOptions): string | number {
    return toast.success(message, options(input))
  },
  info(message: string, input?: NoticeOptions): string | number {
    return toast.info(message, options(input))
  },
  warning(message: string, input?: NoticeOptions): string | number {
    return toast.warning(message, options(input))
  },
  error(message: string, input?: NoticeOptions): string | number {
    return toast.error(message, options(input, errorDuration))
  },
  dismiss(id?: string | number): string | number {
    return toast.dismiss(id)
  }
}

export function NoticeHost({ theme }: { theme: NoticeTheme }) {
  const { t } = useTranslation()
  return (
    <DismissableLayerBranch asChild>
      <Toaster
        className="notice-toaster"
        containerAriaLabel={t('common.notifications')}
        closeButton
        duration={defaultDuration}
        expand
        gap={8}
        offset={{ top: 58, right: 16 }}
        position="top-right"
        richColors={false}
        theme={theme}
        visibleToasts={4}
        toastOptions={{
          closeButtonAriaLabel: t('common.close'),
          classNames: {
            toast: 'notice-toast ui-popover',
            title: 'notice-title',
            description: 'notice-description',
            closeButton: 'notice-close ui-icon-button'
          }
        }}
      />
    </DismissableLayerBranch>
  )
}
