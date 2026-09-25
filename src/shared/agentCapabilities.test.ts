import { selectedTools } from '../test/toolPackageFixture'
import { describe, expect, it } from 'vitest'
import { assertResolvedCapabilities, capabilityFeatures, defaultCapabilities, intersectCapabilities, mcpToolAllowed, mcpServerSelection, removeEmptyMissingMcpSelections, setMcpServerMode, setMcpToolSelection, parseCapabilities, parseRunConfiguration, projectSkillSnapshot, resolveSkillSelection, serializeCapabilities, serializeRunConfiguration, setToolSelection, toolAllowed, validateCapabilities, validateRunConfiguration, type AgentCapabilities } from './agentCapabilities'
import type { SkillSummary } from './types'

const skill = (id: string, modelAvailable = false, userAvailable = false): SkillSummary => ({ scriptAutoApprove: false,
  id, rootId: 'user', name: id, description: '', modelAvailable, userAvailable, dirPath: `/skills/${id}`, linked: false, relativePath: id, source: 'user', rootName: 'User', shortcutAlias: 'user'
})

describe('scoped Agent capabilities', () => {
  it('round trips the project subagent launch policy without a capability ceiling', () => {
    const value = { customTools: [], codingMode: false, capabilities: structuredClone(defaultCapabilities), subagentSelection: { mode: 'custom' as const, names: ['general-purpose'] },
      subagentSelectionLimit: { mode: 'custom' as const, names: ['general-purpose', 'reviewer'] } }
    const raw = serializeRunConfiguration(value)
    expect(raw.subagent_selection).toEqual(value.subagentSelection)
    expect(raw.subagent_selection_limit).toEqual(value.subagentSelectionLimit)
    expect(raw).not.toHaveProperty('subagentSelection')
    expect(parseRunConfiguration(raw)).toEqual(value)
    expect(parseRunConfiguration(raw)).not.toHaveProperty('subagentLimit')
    expect(() => parseRunConfiguration({ ...raw, subagent_selection: { mode: 'unknown', names: [] } })).toThrow()
    expect(() => parseRunConfiguration({ ...raw, subagent_selection_limit: { mode: 'custom', names: ['bad name'] } })).toThrow()
  })

  it('controls terminal input through the background group independently of Shell selection', () => {
    const enabled = { ...structuredClone(defaultCapabilities), customTools: selectedTools(), backgroundTools: true, toolMode: 'all' as const }
    expect(toolAllowed(enabled, 'write_call')).toBe(true)
    expect(toolAllowed({ ...enabled, backgroundTools: false }, 'write_call')).toBe(false)
    const withoutShell = setToolSelection(enabled, ['run_shell'], false)
    expect(toolAllowed(withoutShell, 'write_call')).toBe(true)
    expect(toolAllowed(setToolSelection(withoutShell, ['run_shell'], true), 'write_call')).toBe(true)
    const withoutInput = setToolSelection(enabled, ['write_call'], false)
    expect(toolAllowed(withoutInput, 'run_shell')).toBe(true)
    expect(toolAllowed(withoutInput, 'write_call')).toBe(true)
    for (const id of ['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call']) {
      expect(toolAllowed(setToolSelection(enabled, [id], false), id)).toBe(true)
      expect(toolAllowed({ ...enabled, backgroundTools: false }, id)).toBe(false)
    }
  })
  it('removes empty missing MCP selections without enabling configured servers', () => {
    const value: AgentCapabilities = { ...structuredClone(defaultCapabilities), customTools: selectedTools(), mcp: { defaultMode: 'all', servers: [
      { id: 'removed', mode: 'selected', tools: [] },
      { id: 'configured', mode: 'selected', tools: [] },
      { id: 'missing-all', mode: 'all', tools: [] },
      { id: 'missing-tools', mode: 'selected', tools: ['read'] }
    ] } }
    const ids = new Set(['configured'])
    const cleaned = removeEmptyMissingMcpSelections(value, ids)
    expect(cleaned.mcp.servers.map((server) => server.id)).toEqual(['configured', 'missing-all', 'missing-tools'])
    expect(mcpToolAllowed(cleaned, 'configured', 'read')).toBe(false)
    expect(mcpToolAllowed(cleaned, 'missing-all', 'future')).toBe(true)
    expect(mcpToolAllowed(cleaned, 'missing-tools', 'read')).toBe(true)
    expect(value.mcp.servers).toHaveLength(4)
    expect(removeEmptyMissingMcpSelections(cleaned, ids)).toBe(cleaned)
  })

  it('keeps per-server all mode independent from saved custom tools and builtin policy', () => {
    let value = setMcpToolSelection(defaultCapabilities, 'alpha', 'search', true)
    expect(value.toolMode).toBe('all')
    expect(mcpToolAllowed(value, 'alpha', 'search')).toBe(true)
    expect(mcpToolAllowed(value, 'alpha', 'future')).toBe(false)
    expect(mcpToolAllowed(value, 'beta', 'future')).toBe(true)
    value = setMcpServerMode(value, 'alpha', 'all')
    expect(mcpToolAllowed(value, 'alpha', 'future')).toBe(true)
    expect(mcpServerSelection(value.mcp, 'alpha').tools).toEqual(['search'])
    value = parseCapabilities(serializeCapabilities(value))
    expect(serializeCapabilities(value).mcp).toEqual({ default_mode: 'all', servers: [{ id: 'alpha', mode: 'all', tools: ['search'] }] })
    value = setMcpServerMode(value, 'alpha', 'selected')
    expect(mcpToolAllowed(value, 'alpha', 'future')).toBe(false)
    expect(mcpToolAllowed(value, 'alpha', 'search')).toBe(true)
    expect(setMcpServerMode(defaultCapabilities, 'alpha', 'selected').mcp.servers[0].tools).toEqual([])
  })

  it('isolates MCP server identities and rejects invalid or mixed storage', () => {
    const value = setMcpToolSelection({ ...defaultCapabilities, customTools: selectedTools(), mcp: { defaultMode: 'selected', servers: [] } }, 'alpha', 'search', true)
    expect(mcpToolAllowed(value, 'alpha', 'search')).toBe(true)
    expect(mcpToolAllowed(value, 'beta', 'search')).toBe(false)
    for (const mcp of [undefined, {}, { defaultMode: 'except', servers: [] }, { defaultMode: 'all', servers: [{ id: 'a', mode: 'except', tools: [] }] },
      { defaultMode: 'all', servers: [{ id: 'a', mode: 'selected', tools: [5] }] },
      { defaultMode: 'all', servers: [{ id: 'a', mode: 'all', tools: [] }, { id: 'a', mode: 'selected', tools: [] }] }]) {
      expect(() => validateCapabilities({ ...value, mcp })).toThrow()
    }
    expect(() => validateCapabilities({ ...value, tools: ['mcp:["alpha","search"]'] })).toThrow('per-server MCP policy')
  })

  const mcpPolicies: AgentCapabilities['mcp'][] = [
    { defaultMode: 'all', servers: [] },
    { defaultMode: 'selected', servers: [] },
    { defaultMode: 'all', servers: [{ id: 'alpha', mode: 'selected', tools: ['search'] }] },
    { defaultMode: 'selected', servers: [{ id: 'alpha', mode: 'all', tools: ['ignored'] }, { id: 'beta', mode: 'selected', tools: ['read'] }] }
  ]
  it.each(mcpPolicies.flatMap((left, a) => mcpPolicies.map((right, b) => ({ left, right, a, b }))))('intersects independent MCP policies $a and $b across descendants', ({ left, right }) => {
    const a = { ...defaultCapabilities, customTools: selectedTools(), mcp: left, skills: resolveSkillSelection(defaultCapabilities.skills, []) }
    const b = { ...a, mcp: right }
    const result = intersectCapabilities(a, b)
    const descendant = intersectCapabilities({ ...a, mcp: mcpPolicies[0] }, result)
    for (const server of ['alpha', 'beta', 'future-server']) for (const tool of ['search', 'read', 'future-tool', 'ignored']) {
      const expected = mcpToolAllowed(a, server, tool) && mcpToolAllowed(b, server, tool)
      expect(mcpToolAllowed(result, server, tool)).toBe(expected)
      expect(mcpToolAllowed(descendant, server, tool)).toBe(expected)
    }
  })

  it.each([false, true])('round trips coding mode %s without mixing it into capabilities', (codingMode) => {
    const value = { customTools: [], codingMode, capabilities: structuredClone(defaultCapabilities), subagentLimit: structuredClone(defaultCapabilities) }
    const raw = serializeRunConfiguration(value)
    expect(raw).toEqual({ custom_tools: [], coding_mode: codingMode, capabilities: serializeCapabilities(value.capabilities), subagent_limit: serializeCapabilities(value.subagentLimit) })
    expect(parseRunConfiguration(raw)).toEqual(value)
    expect(parseRunConfiguration(serializeRunConfiguration({ customTools: [], codingMode, capabilities: value.capabilities }))).not.toHaveProperty('subagentLimit')
    for (const invalid of [undefined, null, 0, 'true']) {
      expect(() => parseRunConfiguration({ ...raw, coding_mode: invalid })).toThrow('coding mode')
      expect(() => validateRunConfiguration({ ...value, codingMode: invalid })).toThrow('coding mode')
    }
  })

  it.each(['default', 'project'] as const)('rejects unresolved %s preferences on either side of an intersection', (kind) => {
    const unresolved: AgentCapabilities = { ...defaultCapabilities, customTools: selectedTools(), skills: { ...defaultCapabilities.skills,
      mode: kind === 'default' ? 'default' : 'custom', project: kind === 'project' } }
    const resolved = { ...defaultCapabilities, customTools: selectedTools(), skills: resolveSkillSelection(unresolved.skills, [], true, true) }
    // @ts-expect-error Editable preferences are not resolved capabilities.
    expect(() => intersectCapabilities(unresolved, resolved)).toThrow(/Resolve capability selections/)
    // @ts-expect-error The inherited limit must also be resolved.
    expect(() => intersectCapabilities(resolved, unresolved)).toThrow(/Resolve capability selections/)
    expect(() => assertResolvedCapabilities(unresolved)).toThrow(/Resolve capability selections/)
    expect(() => intersectCapabilities(resolved, resolved)).not.toThrow()
  })
  it('resolves the subagent project rule against each current project without binding skill IDs', () => {
    const selection = { enabled: true, mode: 'custom' as const, project: true, entries: [] }
    for (const id of ['project-a:search', 'project-b:search']) {
      const catalog = [{ ...skill(id), source: 'project' as const }, skill('global')]
      const resolved = resolveSkillSelection(selection, catalog, true, true)
      expect(resolved).toMatchObject({ project: false, entries: [
        { id, model: true, shortcut: false }, { id: 'global', model: false, shortcut: false }
      ] })
      expect(resolveSkillSelection({ ...selection, enabled: false }, catalog, true, true).entries.every((entry) => !entry.model)).toBe(true)
      expect(resolveSkillSelection({ ...selection, project: false, entries: [{ id, model: true, shortcut: false }] }, catalog, true, true).entries[0].model).toBe(false)
      expect(resolveSkillSelection({ ...selection, project: false, entries: [{ id, model: true, shortcut: false }] }, catalog, true).entries[0].model).toBe(true)
    }
    expect(selection.entries).toEqual([])
  })
  it('keeps project skill defaults, load validation, duplicate resolution and parent limits effective', () => {
    const catalog = [
      { ...skill('project:search'), name: 'search', source: 'project' as const },
      { ...skill('user:search', true), name: 'search' },
      { ...skill('broken'), source: 'project' as const, loadError: { code: 'missing_skill_file' as const } }
    ]
    const custom = { enabled: true, mode: 'custom' as const, project: true, entries: [{ id: 'user:search', model: true, shortcut: false }] }
    const resolved = resolveSkillSelection(custom, catalog, true, true)
    expect(resolved.entries.map((entry) => entry.model)).toEqual([true, false])
    expect(resolveSkillSelection({ ...custom, mode: 'default' }, catalog, true, true).entries.map((entry) => entry.model)).toEqual([false, true])
    const child = { ...defaultCapabilities, customTools: selectedTools(), skills: resolved }
    const limit = { ...defaultCapabilities, customTools: selectedTools(), skills: { ...resolved, entries: [{ id: 'project:search', model: false, shortcut: true }] } }
    expect(intersectCapabilities(child, limit).skills.entries.every((entry) => !entry.model)).toBe(true)
    expect(parseCapabilities(serializeCapabilities({ ...defaultCapabilities, customTools: selectedTools(), skills: custom })).skills.project).toBe(true)
  })

  it('preserves unknown MCP tools when excluding an unrelated built-in tool', () => {
    const selection = setToolSelection(defaultCapabilities, ['read_multiple_files'], false)
    expect(selection).toMatchObject({ toolMode: 'except', tools: ['read_multiple_files'] })
    expect(mcpToolAllowed(selection, 'not-loaded-yet', 'search')).toBe(true)
    expect(toolAllowed(selection, 'read_multiple_files')).toBe(false)
    expect(parseCapabilities(serializeCapabilities(selection))).toEqual(selection)
    expect(setToolSelection(selection, ['read_multiple_files'], true).toolMode).toBe('all')
  })
  it.each((['all', 'selected', 'except'] as const).flatMap((left) =>
    (['all', 'selected', 'except'] as const).map((right) => ({ left, right }))
  ))('intersects $left and $right tool policies without enumerating the catalog', ({ left, right }) => {
    const a = { ...defaultCapabilities, customTools: selectedTools(), skills: resolveSkillSelection(defaultCapabilities.skills, []), toolMode: left, tools: ['read_file', 'http_request'] }
    const b = { ...defaultCapabilities, customTools: selectedTools(), skills: resolveSkillSelection(defaultCapabilities.skills, []), toolMode: right, tools: ['http_request', 'write_call'] }
    const result = intersectCapabilities(a, b)
    for (const id of ['read_file', 'http_request', 'run_shell', 'write_call', 'future-tool']) {
      expect(toolAllowed(result, id)).toBe(toolAllowed(a, id) && toolAllowed(b, id))
    }
  })
  it('round trips snake-case persistence without sharing editable defaults', () => {
    const value = structuredClone(defaultCapabilities)
    value.memory = false
    value.tools.push('read_file')
    expect(parseCapabilities(serializeCapabilities(value))).toEqual(value)
    expect(defaultCapabilities.memory).toBe(true)
    expect(defaultCapabilities.tools).toEqual([])
  })
  it.each([false, true])('keeps memory tools independent of automatic recall %s', (memory) => {
    const value = { ...structuredClone(defaultCapabilities), customTools: selectedTools(), memory, toolMode: 'selected' as const, tools: ['read_file', 'read_memory'] }
    expect(toolAllowed(value, 'read_file')).toBe(true)
    expect(toolAllowed(value, 'read_multiple_files')).toBe(false)
    expect(toolAllowed(value, 'read_memory')).toBe(true)
    expect(toolAllowed(value, 'save_to_memory')).toBe(false)
    expect(toolAllowed(value, 'forget_memory')).toBe(false)
    expect(capabilityFeatures(value)).toMatchObject({ fileRead: true, fileWrite: false, memory: true, commandExecution: false })
    expect(capabilityFeatures({ ...value, tools: [] }).memory).toBe(memory)
    expect(parseCapabilities(serializeCapabilities(value))).toEqual(value)
  })
  it('intersects automatic recall separately from memory tool selections', () => {
    const child = { ...structuredClone(defaultCapabilities), customTools: selectedTools(), skills: resolveSkillSelection(defaultCapabilities.skills, []) }
    const limit = { ...child, memory: false, toolMode: 'selected' as const, tools: ['read_memory'] }
    const result = intersectCapabilities(child, limit)
    expect(result.memory).toBe(false)
    expect(toolAllowed(result, 'read_memory')).toBe(true)
    expect(toolAllowed(result, 'save_to_memory')).toBe(false)
    const recallOnly = intersectCapabilities(child, { ...limit, memory: true, tools: [] })
    expect(recallOnly.memory).toBe(true)
    expect(toolAllowed(recallOnly, 'read_memory')).toBe(false)
  })
  it('lets explicit skill selection override global model and shortcut defaults', () => {
    const skills = [skill('private'), skill('public', true, true)]
    const resolved = resolveSkillSelection({ enabled: true, mode: 'custom', project: false, entries: [{ id: 'private', model: true, shortcut: false }] }, skills)
    expect(resolved.entries).toEqual([{ id: 'private', model: true, shortcut: false }, { id: 'public', model: false, shortcut: false }])
    expect(resolveSkillSelection(defaultCapabilities.skills, skills).entries[1]).toEqual({ id: 'public', model: true, shortcut: true })
  })
  it('keeps shortcut-only skills out of the model selection', () => {
    const selection = { enabled: true, mode: 'custom' as const, project: false, entries: [{ id: 'private', shortcut: true, model: false }] }
    const snapshot = projectSkillSnapshot({ scriptAutoApprove: false, roots: [], skills: [skill('private')] }, selection)
    expect(snapshot?.skills[0]).toMatchObject({ userAvailable: true, modelAvailable: false, shortcut: '/private' })
    expect(projectSkillSnapshot(snapshot, { ...selection, enabled: false })?.skills[0]).toMatchObject({ userAvailable: false, modelAvailable: false })
  })
  it('resolves duplicate model skill names to the first selected source', () => {
    const skills = [
      { ...skill('project/search', true, true), name: 'search', rootName: 'Project' },
      { ...skill('user/search', true, true), name: 'search', rootName: 'User' }
    ]
    expect(resolveSkillSelection(defaultCapabilities.skills, skills, true).entries.map((entry) => entry.model)).toEqual([true, false])
    const snapshot = projectSkillSnapshot({ scriptAutoApprove: false, roots: [], skills }, defaultCapabilities.skills)
    expect(snapshot?.skills[1]).toMatchObject({ modelShadowedBy: 'Project', shortcut: '/search@user' })
  })
  it('applies the project ceiling to tools, every context, environment, and model skills', () => {
    const parent = structuredClone(defaultCapabilities)
    parent.toolMode = 'selected'
    parent.tools = ['read_file']
    Object.assign(parent, { profile: false, environment: false, workspace: false, memory: false })
    parent.applicationEnvironment = false
    parent.backgroundTools = false
    parent.skills = { enabled: true, mode: 'custom', project: false, entries: [{ id: 'private', model: false, shortcut: true }, { id: 'public', model: true, shortcut: false }] }
    const child = structuredClone(defaultCapabilities)
    child.skills = { enabled: true, mode: 'custom', project: false, entries: [{ id: 'private', model: true, shortcut: false }, { id: 'public', model: true, shortcut: false }] }
    child.customTools = selectedTools()
    parent.customTools = selectedTools()
    assertResolvedCapabilities(child)
    assertResolvedCapabilities(parent)
    const limited = intersectCapabilities(child, parent)
    expect(limited).toMatchObject({ profile: false, environment: false, workspace: false, memory: false })
    expect(limited.applicationEnvironment).toBe(false)
    expect(limited.backgroundTools).toBe(false)
    expect(limited.tools).toEqual(['read_file'])
    expect(limited.skills.entries.map((entry) => entry.model)).toEqual([false, true])
    expect(intersectCapabilities(child, limited)).toEqual(limited)
    expect(child.memory).toBe(true)
    expect(child.applicationEnvironment).toBe(true)
  })
  it.each([undefined, {}, { ...defaultCapabilities, customTools: selectedTools(), toolMode: 'invalid' }, { ...defaultCapabilities, customTools: selectedTools(), applicationEnvironment: 'yes' }, { ...defaultCapabilities, customTools: selectedTools(), skills: { enabled: true, mode: 'inherit', entries: [] } }])('rejects incomplete or invalid settings', (value) => {
    expect(() => validateCapabilities(value)).toThrow()
  })
})
