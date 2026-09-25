import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { resolve } from 'node:path'
import { z } from 'zod/v3'
import { assistantNewAvatarPathKey, updateConfigValue } from '../config/appConfig'
import { consumePendingAvatarUpdate } from '../avatarConfigService'
import { toolSummarySchema } from './toolSummary'

const jsonValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.unknown()),
  z.record(z.unknown())
])

function configToolError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function decodeJsonText(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function isConfigValueRejection(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Config value ')
}

async function applyConfigValue(input: {
  config: 'settings'
  key: string
  value: unknown
}, primaryFolder: string): Promise<string> {
  const value = input.key === assistantNewAvatarPathKey
    && typeof input.value === 'string'
    && input.value !== 'default'
    && input.value.trim().length > 0
    ? resolve(primaryFolder, input.value)
    : input.value
  let result
  try {
    result = await updateConfigValue(input.config, input.key, value)
  } catch (error) {
    const decodedValue = decodeJsonText(value)
    if (decodedValue === value || !isConfigValueRejection(error)) {
      return JSON.stringify({ ok: false, error: configToolError(error) })
    }
    try {
      result = await updateConfigValue(input.config, input.key, decodedValue)
    } catch (decodedError) {
      return JSON.stringify({ ok: false, error: configToolError(decodedError) })
    }
  }
  let avatarUpdated: boolean | undefined
  if (result.key === assistantNewAvatarPathKey && typeof result.value === 'string') {
    try {
      avatarUpdated = (await consumePendingAvatarUpdate(result.value)).applied
    } catch (error) {
      return JSON.stringify({ ok: false, error: configToolError(error) })
    }
  }
  return JSON.stringify({
    ok: true,
    changed: result.changed,
    config: result.config,
    key: result.key,
    value: result.key === assistantNewAvatarPathKey ? '' : result.value,
    ...(avatarUpdated === undefined ? {} : { avatar_updated: avatarUpdated })
  })
}

export function createConfigTools(primaryFolder: string): StructuredToolInterface[] {
  return [
    tool((input) => applyConfigValue(input, primaryFolder), {
      name: 'update_config',
      description: 'Update one supported application configuration value only when the user explicitly asks to change it. Most values persist; profile.assistant.new_avatar_path submits a one-time avatar request and is cleared after the attempt. Set it to an image path to replace the avatar or to "default" to restore the default avatar. The only supported config document is settings. Use a dot-separated snake_case key from settings.json. Pass the new value itself in value; never serialize it into JSON text. Arrays and objects replace the complete value atomically.',
      schema: z.object({
        summary: toolSummarySchema,
        config: z.enum(['settings']).describe('Configuration document to update. Currently only settings is supported.'),
        key: z.string().trim().min(1).describe('Existing dot-separated snake_case path inside settings.json. profile.assistant.new_avatar_path is a one-time avatar request: use an image path to replace the avatar or "default" to restore it, and Anas clears the value after the attempt. Other examples include theme, profile.user.preferred_name, speech_reply.enabled, and environment_context.custom_information.'),
        value: jsonValueSchema.describe(
          'New value as an actual JSON-typed tool argument, not serialized JSON text. '
          + 'Correct examples: a string uses value: "text"; a switch uses value: true; '
          + 'a number uses value: 14; a list uses value: ["first", "second"]; '
          + 'an object uses value: {"enabled": true}. '
          + 'Do not add quote characters around a string, and do not pass an array or object as a string.'
        )
      })
    })
  ]
}
