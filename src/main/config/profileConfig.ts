import type { AppProfile } from '@shared/types'
import { asRecord, type RawAppProfile } from './rawAppConfig'

function stringValue(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key]
  if (typeof value === 'string') return value
  throw new Error(`Config value ${path} must be a string.`)
}

export function normalizeAppProfile(value: unknown): AppProfile {
  const profile = asRecord(value)
  const assistant = asRecord(profile.assistant)
  const user = asRecord(profile.user)
  const assistantName = stringValue(assistant, 'name', 'profile.assistant.name').trim()
  if (!assistantName) throw new Error('Config value profile.assistant.name must not be empty.')
  return {
    assistant: {
      name: assistantName,
      role: stringValue(assistant, 'role', 'profile.assistant.role'),
      instructions: stringValue(assistant, 'instructions', 'profile.assistant.instructions'),
      newAvatarPath: stringValue(assistant, 'new_avatar_path', 'profile.assistant.new_avatar_path')
    },
    user: {
      preferredName: stringValue(user, 'preferred_name', 'profile.user.preferred_name'),
      personalInfo: stringValue(user, 'personal_info', 'profile.user.personal_info')
    }
  }
}

export function rawAppProfile(profile: AppProfile): RawAppProfile {
  return {
    assistant: {
      name: profile.assistant.name,
      role: profile.assistant.role,
      instructions: profile.assistant.instructions,
      new_avatar_path: profile.assistant.newAvatarPath
    },
    user: {
      preferred_name: profile.user.preferredName,
      personal_info: profile.user.personalInfo
    }
  }
}
