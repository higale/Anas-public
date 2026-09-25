import type { TFunction } from 'i18next'
import type { McpServerConfigDetail, McpServerConfigSave, McpServerType, McpToolStatus } from '@shared/types'

export interface McpDraft {
  index?: number
  name: string
  enabled: boolean
  timeoutMs: number
  type: McpServerType
  url: string
  apiKey: string
  id: string
  command: string
  argsText: string
  workingDir: string
  envText: string
}

export function emptyMcpDraft(t: TFunction): McpDraft {
  return {
    name: t('settings.new_mcp_server'),
    enabled: false,
    timeoutMs: 30000,
    type: 'stdio',
    url: '',
    apiKey: '',
    id: 'mcp_server',
    command: '',
    argsText: '',
    workingDir: '',
    envText: ''
  }
}

export function mcpDetailToDraft(server: McpServerConfigDetail): McpDraft {
  return {
    index: server.index,
    name: server.name,
    enabled: server.enabled,
    timeoutMs: server.timeoutMs,
    type: server.type,
    url: server.url,
    apiKey: server.apiKey ?? '',
    id: server.id,
    command: server.command,
    argsText: server.args.join('\n'),
    workingDir: server.workingDir,
    envText: Object.entries(server.env).map(([key, value]) => `${key}=${value}`).join('\n')
  }
}

function parseMcpEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf('=')
        return index < 0 ? [line, ''] : [line.slice(0, index).trim(), line.slice(index + 1).trim()]
      })
      .filter(([key]) => key)
  )
}

export function buildMcpPayload(draft: McpDraft): McpServerConfigSave {
  return {
    index: draft.index,
    name: draft.name,
    enabled: draft.enabled,
    timeoutMs: draft.timeoutMs,
    type: draft.type,
    url: draft.url,
    apiKey: draft.apiKey,
    id: draft.id,
    command: draft.command,
    args: draft.argsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    workingDir: draft.workingDir,
    env: parseMcpEnv(draft.envText)
  }
}

export function validateMcpDraftForEnable(draft: McpDraft, t: TFunction): string | undefined {
  if (!draft.name.trim()) return t('settings.name_required_enable')
  if (!draft.id.trim()) return t('settings.mcp_server_id_required_enable')
  if (!Number.isFinite(draft.timeoutMs) || draft.timeoutMs < 1000) return t('settings.timeout_required_enable')
  if (draft.type === 'stdio' && !draft.command.trim()) return t('settings.command_required_enable')
  if (draft.type !== 'stdio' && !draft.url.trim()) return t('settings.url_required_enable')
  return undefined
}

export function validateMcpDraftId(draft: McpDraft, t: TFunction): string | undefined {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(draft.id.trim())
    ? undefined
    : t('settings.mcp_server_id_invalid')
}

export function validateMcpDraftIdUnique(draft: McpDraft, servers: Array<{ id: string; index: number }> | undefined, t: TFunction): string | undefined {
  const id = draft.id.trim()
  if (!id) return undefined
  return servers?.some((server) => server.index !== draft.index && server.id === id)
    ? t('settings.mcp_server_id_duplicate')
    : undefined
}

export function nextMcpServerId(servers: Array<{ id: string }> | undefined): string {
  const existing = new Set(servers?.map((server) => server.id) ?? [])
  let suffix = (servers?.length ?? 0) + 1
  let id = `mcp_server_${suffix}`
  while (existing.has(id)) {
    suffix += 1
    id = `mcp_server_${suffix}`
  }
  return id
}

type McpServerRef = Pick<McpServerConfigDetail, 'id' | 'index'>

export function mcpLoadedStatus(status: McpToolStatus | undefined, server: McpServerRef): { toolCount: number; toolNames: string[] } | undefined {
  return status?.loaded.find((item) => item.index === server.index && item.id === server.id)
}

export function mcpServerRuntimeStatus(status: McpToolStatus | undefined, server: McpServerRef): McpToolStatus['servers'][number] | undefined {
  return status?.servers.find((item) => item.index === server.index && item.id === server.id)
}

export function mcpErrorStatus(status: McpToolStatus | undefined, server: McpServerRef): string | undefined {
  return mcpServerRuntimeStatus(status, server)?.lastError ?? status?.errors.find((item) => item.index === server.index && item.id === server.id)?.error
}
