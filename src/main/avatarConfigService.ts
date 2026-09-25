import { assistantNewAvatarPathKey, clearNewAvatarPath, getAppConfigSnapshot } from './config/appConfig'
import { clearAvatarImage, setAvatarImageFromSource } from './attachments'

let avatarConfigRefreshTail: Promise<void> = Promise.resolve()
let lastCompletedAvatarUpdate:
  | { error: unknown; path: string }
  | { path: string; result: PendingAvatarUpdateResult }
  | undefined

export interface PendingAvatarUpdateResult {
  applied: boolean
  key: typeof assistantNewAvatarPathKey
  path?: string
}

function serializeAvatarConfigRefresh<T>(refresh: () => Promise<T>): Promise<T> {
  const result = avatarConfigRefreshTail.then(refresh, refresh)
  avatarConfigRefreshTail = result.then(() => undefined, () => undefined)
  return result
}

export function consumePendingAvatarUpdate(expectedPath?: string): Promise<PendingAvatarUpdateResult> {
  return serializeAvatarConfigRefresh(async () => {
    const snapshot = await getAppConfigSnapshot()
    const path = snapshot.settings.profile.assistant.newAvatarPath
    if (!path) {
      if (expectedPath !== undefined && lastCompletedAvatarUpdate?.path === expectedPath) {
        if ('error' in lastCompletedAvatarUpdate) throw lastCompletedAvatarUpdate.error
        return lastCompletedAvatarUpdate.result
      }
      return { applied: false, key: assistantNewAvatarPathKey }
    }
    if (expectedPath !== undefined && path !== expectedPath) {
      throw new Error('Avatar update was superseded by a newer avatar path.')
    }

    let updateError: unknown
    let updateFailed = false
    try {
      if (path === 'default') await clearAvatarImage()
      else await setAvatarImageFromSource(path)
    } catch (reason) {
      updateError = reason
      updateFailed = true
    }

    try {
      await clearNewAvatarPath(path)
    } catch (clearError) {
      if (updateFailed) {
        throw new AggregateError(
          [updateError, clearError],
          'Avatar update failed and its pending path could not be cleared.'
        )
      }
      throw clearError
    }

    if (updateFailed) {
      lastCompletedAvatarUpdate = { error: updateError, path }
      throw updateError
    }
    const result = { applied: true, key: assistantNewAvatarPathKey, path } as const
    lastCompletedAvatarUpdate = { path, result }
    return result
  })
}
