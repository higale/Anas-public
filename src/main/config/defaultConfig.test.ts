import capabilities from '../../../data/config/capabilities.json'
import { defaultCapabilities, serializeCapabilities, parseCapabilities } from '@shared/agentCapabilities'
import settings from '../../../data/config/settings.json'
import mcpServers from '../../../data/config/mcp_servers.json'
import models from '../../../data/config/models.json'
import subagents from '../../../data/config/subagents.json'
import { describe, expect, it } from 'vitest'
import { defaultModelConfig, defaultModelProviderConfig } from '@shared/modelConfig'
import { modelTemplates, modelTemplateTree } from '@shared/modelTemplates'
import { defaultSubagentConfig } from '@shared/subagentConfig'
import { normalizeAppConfigSnapshot } from './appConfig'
import type { RawAppConfig } from './rawAppConfig'

describe('bundled configuration contract', () => {
  it('strictly maps every bundled model, subagent, setting, and enum', () => {
    const snapshot = normalizeAppConfigSnapshot({
      settings,
      capabilities,
      providers: models.providers,
      subagents: subagents.subagents,
      mcp_servers: mcpServers.mcp_servers
    } as RawAppConfig)

    expect(snapshot.providers).toHaveLength(models.providers.length)
    expect(snapshot.subagents).toHaveLength(subagents.subagents.length)
    expect(snapshot.defaultModel).toBeUndefined()
    expect(snapshot.settings.sidebarCollapsedSections).toEqual({
      projects: false,
      simpleChats: false
    })
    expect(snapshot.settings.sidebarWidth).toBe(260)
    expect(snapshot.settings.environmentContext.customInformationEnabled).toBe(settings.environment_context.custom_information_enabled)
  })

  it('keeps the new-model defaults separate from every concrete model entry', () => {
    expect(defaultModelProviderConfig).toMatchObject({
      parameters: models.provider_defaults.parameters
    })
    expect(defaultModelConfig).toMatchObject({
      maxContextTokens: models.model_defaults.max_context_tokens,
      maxOutputTokens: models.model_defaults.max_output_tokens
    })
    expect(models.providers).toEqual([])
    expect(modelTemplateTree.map((node) => node.label)).toEqual([
      'Local',
      'China',
      'United States',
      'France'
    ])
    expect(modelTemplates.every((provider) => (
      provider.protocol !== undefined
      && provider.baseUrl.length > 0
      && provider.modelListUrl.length > 0
      && (provider.modelListAuth === 'bearer' || provider.modelListAuth === 'anthropic')
    ))).toBe(true)
  })

  it('enables profile context for the bundled general-purpose subagent', () => {
    const general = subagents.subagents.find((subagent) => subagent.preset === 'general-purpose')
    expect(parseCapabilities(general?.capabilities).profile).toBe(true)
  })

  it('gives the bundled web researcher shell, file reading, and network tools without delegation or planning', () => {
    const researcher = subagents.subagents.find((subagent) => subagent.preset === 'web-researcher')
    expect(parseCapabilities(researcher?.capabilities)).toMatchObject({
      workspace: false,
      memory: false,
      subagents: false,
      planning: false,
      toolMode: 'selected',
      tools: ['run_shell', 'read_file', 'http_request']
    })
  })

  it('adds shell and network tools alongside the bundled project analyst file tools', () => {
    const analyst = subagents.subagents.find((subagent) => subagent.preset === 'project-analyst')
    expect(analyst).toMatchObject({
 capabilities: serializeCapabilities({ ...structuredClone(defaultCapabilities), profile: false, toolMode: 'selected', tools: [
        'read_file',
        'read_multiple_files',
        'list_directory',
        'directory_tree',
        'get_file_info',
        'run_shell',
        'http_request'
      ], mcp: { defaultMode: 'selected', servers: [] }, skills: { enabled: true, mode: 'custom', project: false, entries: [] } }),
    })
  })

  it('keeps custom subagent defaults separate from built-in presets', () => {
    expect(defaultSubagentConfig.capabilities.profile).toBe(true)
    expect(defaultSubagentConfig).toEqual({
 capabilities: parseCapabilities(subagents.subagent_defaults.capabilities),
      enabled: subagents.subagent_defaults.enabled,
      subagentSelection: subagents.subagent_defaults.subagent_selection,
    })
  })
})
