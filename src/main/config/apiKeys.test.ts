import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

async function loadApiKeysWithEnv(content: string) {
  vi.resetModules()
  const dir = await mkdtemp(join(tmpdir(), 'anas-api-keys-'))
  tempDirs.push(dir)
  const envPath = join(dir, '.env')
  await writeFile(envPath, content, 'utf8')
  vi.doMock('./dataDir', () => ({
    getBundledEnvFile: () => join(dir, 'missing-bundled.env'),
    getEnvFile: () => envPath
  }))
  return {
    apiKeys: await import('./apiKeys'),
    envPath
  }
}

afterEach(async () => {
  vi.doUnmock('./dataDir')
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('environment values', () => {
  it('resolves model credentials only from the provider configuration', async () => {
    const openAiKey = process.env.OPENAI_API_KEY
    const anthropicKey = process.env.ANTHROPIC_API_KEY
    process.env.OPENAI_API_KEY = 'system-openai-secret'
    process.env.ANTHROPIC_API_KEY = 'system-anthropic-secret'
    const { apiKeys } = await loadApiKeysWithEnv(
      'OPENAI_API_KEY=data-openai-secret\nANTHROPIC_API_KEY=data-anthropic-secret\n'
    )

    try {
      apiKeys.loadDataEnv()
      expect(apiKeys.resolveModelApiKey({ apiKey: ' configured-secret ' })).toBe('configured-secret')
      expect(apiKeys.resolveModelApiKey({ apiKey: '' })).toBeUndefined()
      expect(apiKeys.resolveModelApiKey({})).toBeUndefined()
    } finally {
      if (openAiKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = openAiKey
      if (anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = anthropicKey
    }
  })

  it('reports only keys missing from both the data file and system environment', async () => {
    const localKey = 'ANAS_TEST_LOCAL_ENV_SOURCE'
    const systemKey = 'ANAS_TEST_SYSTEM_ENV_SOURCE'
    const missingKey = 'ANAS_TEST_MISSING_ENV_SOURCE'
    const previousLocal = process.env[localKey]
    const previousSystem = process.env[systemKey]
    const previousMissing = process.env[missingKey]
    process.env[localKey] = 'system-local'
    process.env[systemKey] = 'system-only'
    delete process.env[missingKey]

    try {
      const { apiKeys } = await loadApiKeysWithEnv(`${localKey}=local-value\n`)
      expect(apiKeys.missingDataEnvKeys([localKey, systemKey, missingKey, missingKey]))
        .toEqual([missingKey])
      expect(apiKeys.resolveDataEnvValue(localKey)).toBe('local-value')
      expect(apiKeys.resolveDataEnvValue(systemKey)).toBe('system-only')
    } finally {
      if (previousLocal === undefined) delete process.env[localKey]
      else process.env[localKey] = previousLocal
      if (previousSystem === undefined) delete process.env[systemKey]
      else process.env[systemKey] = previousSystem
      if (previousMissing === undefined) delete process.env[missingKey]
      else process.env[missingKey] = previousMissing
    }
  })

  it('falls back to the system value when the local assignment is empty', async () => {
    const key = 'ANAS_TEST_EMPTY_LOCAL_ENV_SOURCE'
    const previous = process.env[key]
    process.env[key] = 'system-value'

    try {
      const { apiKeys } = await loadApiKeysWithEnv(`${key}=\n`)
      expect(apiKeys.missingDataEnvKeys([key])).toEqual([])
      expect(apiKeys.resolveDataEnvValue(key)).toBe('system-value')
      expect(process.env[key]).toBe('system-value')
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it('isolates enabled and disabled execution environments without mutating the host', async () => {
    const overriddenKey = 'ANAS_TEST_TOGGLED_ENV_SOURCE'
    const localOnlyKey = 'ANAS_TEST_TOGGLED_LOCAL_ONLY'
    const previousOverridden = process.env[overriddenKey]
    const previousLocalOnly = process.env[localOnlyKey]
    process.env[overriddenKey] = 'system-value'
    delete process.env[localOnlyKey]

    try {
      const { apiKeys } = await loadApiKeysWithEnv(
        `${overriddenKey}=local-value\n${localOnlyKey}=local-only\n`
      )
      expect(apiKeys.resolveDataEnvValue(overriddenKey)).toBe('local-value')
      expect(apiKeys.processEnvironment(true)[localOnlyKey]).toBe('local-only')
      const enabledEnvironment = apiKeys.processEnvironment(true)
      expect(apiKeys.processEnvironment(false)[overriddenKey]).toBe('system-value')
      expect(apiKeys.processEnvironment(false)[localOnlyKey]).toBeUndefined()
      expect(process.env[overriddenKey]).toBe('system-value')
      expect(process.env[localOnlyKey]).toBeUndefined()

      apiKeys.writeDataEnvFile(`${overriddenKey}=updated-local\n${localOnlyKey}=updated-only\n`)
      expect(enabledEnvironment[overriddenKey]).toBe('local-value')
      expect(apiKeys.processEnvironment(false)[overriddenKey]).toBe('system-value')
      expect(apiKeys.resolveDataEnvValue(overriddenKey)).toBe('updated-local')
      expect(apiKeys.resolveDataEnvValue(localOnlyKey)).toBe('updated-only')
    } finally {
      if (previousOverridden === undefined) delete process.env[overriddenKey]
      else process.env[overriddenKey] = previousOverridden
      if (previousLocalOnly === undefined) delete process.env[localOnlyKey]
      else process.env[localOnlyKey] = previousLocalOnly
    }
  })
})
