import { runApplicationDataOperation } from './applicationDataLifecycle'
import { fillEmptyCustomEnvironmentInformation, getAppConfigSnapshot } from './config/appConfig'
import { runtimeLog } from './runtimeLogger'
import { detectSystemEnvironment } from './systemEnvironmentDetection'

export async function initializeCustomEnvironmentInformation(): Promise<void> {
  try {
    await runApplicationDataOperation(async () => {
      const config = await getAppConfigSnapshot()
      const context = config.settings.environmentContext
      if (!context.customInformationEnabled || context.customInformation.trim()) return
      const detection = await detectSystemEnvironment()
      await fillEmptyCustomEnvironmentInformation(detection.content)
    })
  } catch (reason) {
    runtimeLog('warn', 'runtime', 'Failed to initialize custom environment information.', { error: reason })
  }
}
