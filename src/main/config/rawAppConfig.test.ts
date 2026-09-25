import capabilityDefaults from '../../../data/config/capabilities.json'
import nativeFs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []
const nativeRename = nativeFs.rename
let renameFailure: { path: string; code: string; remaining: number; original: string; attempts: number } | undefined
// Exercise the real dependency's retry loop, injecting only the OS sharing
// error on this test's exact destination. Other filesystem operations stay real.
nativeFs.rename = Object.assign((...args: Parameters<typeof nativeRename>) => {
  const [from, to, callback] = args
  if (renameFailure && to === renameFailure.path) {
    renameFailure.attempts += 1
    if (renameFailure.remaining > 0) {
      renameFailure.remaining -= 1
      expect(nativeFs.readFileSync(to, 'utf8')).toBe(renameFailure.original)
      callback(Object.assign(new Error('Injected config sharing failure.'), { code: renameFailure.code }))
      return
    }
  }
  nativeRename(from, to, callback)
}, nativeRename)

afterAll(() => { nativeFs.rename = nativeRename })

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function loadRawConfig() {
  vi.resetModules()
  const root = await mkdtemp(join(tmpdir(), 'anas-config-store-'))
  const bundledDir = join(root, 'bundled')
  const configDir = join(root, 'user')
  tempDirs.push(root)
  const fileNames = {
    capabilities: 'capabilities.json',
    settings: 'settings.json',
    models: 'models.json',
    subagents: 'subagents.json',
    mcpServers: 'mcp_servers.json',
    customTools: 'tools.json',
    skills: 'skills.json'
  } as const
  vi.doMock('./dataDir', () => ({
    capabilitiesConfigFileName: fileNames.capabilities,
    settingsConfigFileName: fileNames.settings,
    modelsConfigFileName: fileNames.models,
    subagentsConfigFileName: fileNames.subagents,
    mcpServersConfigFileName: fileNames.mcpServers,
    customToolsConfigFileName: fileNames.customTools,
    skillsConfigFileName: fileNames.skills,
    configFileNames: Object.values(fileNames),
    getBundledConfigFile: (fileName = fileNames.settings) => join(bundledDir, fileName),
    getConfigDir: () => configDir,
    getConfigFile: (fileName = fileNames.settings) => join(configDir, fileName)
  }))
  await writeJson(join(bundledDir, fileNames.customTools), { tools: [] })
  await writeJson(join(bundledDir, fileNames.capabilities), capabilityDefaults)
  return {
    bundledDir,
    configDir,
    fileNames,
    rawConfig: await import('./rawAppConfig')
  }
}

afterEach(async () => {
  renameFailure = undefined
  vi.doUnmock('./dataDir')
  vi.resetModules()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('domain config storage', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries transient %s when replacing an existing config', async (code) => {
    const { configDir, fileNames, rawConfig } = await loadRawConfig()
    const path = join(configDir, fileNames.settings)
    await writeJson(path, { default_model_id: 'original' })
    renameFailure = { path, code, remaining: 2, original: await readFile(path, 'utf8'), attempts: 0 }

    await rawConfig.writeRawSettingsConfig({ settings: { default_model_id: 'updated' } })

    expect(renameFailure.attempts).toBeGreaterThanOrEqual(3)
    expect(await readFile(path, 'utf8')).toBe('{\n  "default_model_id": "updated"\n}\n')
    expect(await readdir(configDir)).toEqual([fileNames.settings])
  })

  it('bounds permanent sharing failures without replacing the original or leaving a writer', async () => {
    const { configDir, fileNames, rawConfig } = await loadRawConfig()
    const path = join(configDir, fileNames.settings)
    await writeJson(path, { default_model_id: 'original' })
    const original = await readFile(path, 'utf8')
    renameFailure = { path, code: 'EPERM', remaining: Infinity, original, attempts: 0 }
    const startedAt = Date.now()

    await expect(rawConfig.writeRawSettingsConfig({ settings: { default_model_id: 'updated' } }))
      .rejects.toMatchObject({ code: 'EPERM' })

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(2_000)
    expect(renameFailure.attempts).toBeGreaterThan(1)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await readdir(configDir)).toEqual([fileNames.settings])
    // A following write can complete normally, rather than racing any old
    // background retry against the new destination after the rejection.
    renameFailure.remaining = 1
    await rawConfig.writeRawSettingsConfig({ settings: { default_model_id: 'next' } })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ default_model_id: 'next' })
  })

  it('does not retry non-transient rename errors and preserves the original config', async () => {
    const { configDir, fileNames, rawConfig } = await loadRawConfig()
    const path = join(configDir, fileNames.settings)
    await writeJson(path, { default_model_id: 'original' })
    const original = await readFile(path, 'utf8')
    renameFailure = { path, code: 'EINVAL', remaining: Infinity, original, attempts: 0 }

    await expect(rawConfig.writeRawSettingsConfig({ settings: { default_model_id: 'updated' } }))
      .rejects.toMatchObject({ code: 'EINVAL' })

    expect(renameFailure.attempts).toBe(1)
    expect(await readFile(path, 'utf8')).toBe(original)
    expect(await readdir(configDir)).toEqual([fileNames.settings])
  })

  it('merges settings defaults and reads the main model ID from settings config', async () => {
    const { bundledDir, configDir, fileNames, rawConfig } = await loadRawConfig()
    await writeJson(join(bundledDir, fileNames.settings), {
      profile: {
        assistant: {
          name: 'Ananas',
          role: 'Default role',
          instructions: 'Default instructions',
          new_avatar_path: ''
        },
        user: {
          preferred_name: '',
          personal_info: ''
        }
      },
      default_model_id: 'bundled',
      language: 'system',
      environment_context: {
        operating_system: true,
        power_shell: true,
        bundled_commands: true,
        current_date: true,
        application_data_directory: true,
        user_home_directory: true,
        custom_information_enabled: true,
        custom_information: ''
      },
      sidebar_collapsed_sections: {
        projects: false,
        simple_chats: false
      },
      speech_reply: { enabled: false, speed: 1 }
    })
    await writeJson(join(bundledDir, fileNames.models), {
      providers: [{ id: 'bundled', name: 'Bundled' }]
    })
    await writeJson(join(bundledDir, fileNames.subagents), {
      subagents: [{ name: 'general-purpose' }]
    })
    await writeJson(join(bundledDir, fileNames.mcpServers), {
      mcp_servers: []
    })
    await writeJson(join(bundledDir, fileNames.skills), { external_directories: [], availability: {} })
    await writeJson(join(configDir, fileNames.settings), {
      profile: {
        assistant: { name: 'Local' },
        user: { personal_info: 'Local user information' }
      },
      default_model_id: 'selected',
      environment_context: {
        current_date: false,
        custom_information: 'Local environment'
      },
      sidebar_collapsed_sections: {
        projects: true
      }
    })
    await writeJson(join(configDir, fileNames.models), {
      providers: [{ id: 'first', name: 'First' }, { id: 'selected', name: 'Selected' }]
    })

    const result = await rawConfig.readRawConfig()

    expect(result.settings?.profile).toEqual({
      assistant: {
        name: 'Local',
        role: 'Default role',
        instructions: 'Default instructions',
        new_avatar_path: ''
      },
      user: {
        preferred_name: '',
        personal_info: 'Local user information'
      }
    })
    expect(result.settings).toMatchObject({
      default_model_id: 'selected',
      language: 'system',
      environment_context: {
        operating_system: true,
        power_shell: true,
        bundled_commands: true,
        current_date: false,
        application_data_directory: true,
        user_home_directory: true,
        custom_information_enabled: true,
        custom_information: 'Local environment'
      },
      sidebar_collapsed_sections: {
        projects: true,
        simple_chats: false
      }
    })
    expect(result.settings).not.toHaveProperty('persona_name')
    expect(result.settings).not.toHaveProperty('persona_description')
    expect(result.providers).toEqual([{ id: 'first', name: 'First' }, { id: 'selected', name: 'Selected' }])
    expect(result.subagents).toEqual([{ name: 'general-purpose' }])
    await expect(readFile(join(configDir, fileNames.subagents), 'utf8')).resolves.toContain('general-purpose')
    expect((await rawConfig.readRawConfig()).capabilities).toEqual(capabilityDefaults)
    const capabilities = { ...capabilityDefaults, profile: false, restrict_subagents: true }
    await rawConfig.writeRawCapabilitiesConfig({ capabilities })
    expect((await rawConfig.readRawConfig()).capabilities).toEqual(capabilities)
    expect(JSON.parse(await readFile(join(configDir, fileNames.capabilities), 'utf8'))).toEqual(capabilities)
  })

  it('writes only the requested domain file', async () => {
    const { bundledDir, configDir, fileNames, rawConfig } = await loadRawConfig()
    await Promise.all([
      writeJson(join(bundledDir, fileNames.settings), {
        profile: {
          assistant: { name: 'Ananas', role: 'Default role', instructions: 'Default instructions', new_avatar_path: '' },
          user: { preferred_name: '', personal_info: '' }
        },
        default_model_id: null,
        speech_reply: {}
      }),
      writeJson(join(bundledDir, fileNames.models), { providers: [] }),
      writeJson(join(bundledDir, fileNames.subagents), { subagents: [] }),
      writeJson(join(bundledDir, fileNames.mcpServers), { mcp_servers: [] }),
      writeJson(join(bundledDir, fileNames.skills), { external_directories: [], availability: {} })
    ])
    await writeJson(join(configDir, fileNames.settings), {
      profile: {
        assistant: { name: 'Ananas', role: 'Default role', instructions: 'Default instructions', new_avatar_path: '' },
        user: { preferred_name: '', personal_info: '' }
      },
      default_model_id: null,
      speech_reply: {}
    })
    await rawConfig.readRawConfig()
    const originalSettings = await readFile(join(configDir, fileNames.settings), 'utf8')

    await rawConfig.writeRawModelsConfig({
      providers: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }]
    })

    await expect(readFile(join(configDir, fileNames.settings), 'utf8')).resolves.toBe(originalSettings)
    const models = JSON.parse(await readFile(join(configDir, fileNames.models), 'utf8'))
    expect(models).toEqual({
      providers: [{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }]
    })

    await rawConfig.writeRawSettingsConfig({
      settings: {
        profile: {
          assistant: {
            name: 'Local assistant',
            role: 'Local role',
            instructions: 'Local instructions',
            new_avatar_path: ''
          },
          user: {
            preferred_name: 'Gale',
            personal_info: 'Local personal information'
          }
        },
        default_model_id: 'second',
        speech_reply: {}
      }
    })
    const settings = JSON.parse(await readFile(join(configDir, fileNames.settings), 'utf8'))
    expect(settings).toEqual({
      profile: {
        assistant: {
          name: 'Local assistant',
          role: 'Local role',
          instructions: 'Local instructions',
          new_avatar_path: ''
        },
        user: {
          preferred_name: 'Gale',
          personal_info: 'Local personal information'
        }
      },
      default_model_id: 'second',
      speech_reply: {}
    })
  })

  it('does not publish the English settings template before profile initialization', async () => {
    const { bundledDir, configDir, fileNames, rawConfig } = await loadRawConfig()
    await Promise.all([
      writeJson(join(bundledDir, fileNames.settings), {
        profile: {
          assistant: { name: 'Ananas', role: 'English role', instructions: 'English instructions', new_avatar_path: '' },
          user: { preferred_name: '', personal_info: '' }
        },
        default_model_id: null,
        speech_reply: {}
      }),
      writeJson(join(bundledDir, fileNames.models), { providers: [] }),
      writeJson(join(bundledDir, fileNames.subagents), { subagents: [] }),
      writeJson(join(bundledDir, fileNames.mcpServers), { mcp_servers: [] }),
      writeJson(join(bundledDir, fileNames.skills), { external_directories: [], availability: {} })
    ])

    await expect(rawConfig.readRawConfig()).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(configDir, fileNames.settings), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
