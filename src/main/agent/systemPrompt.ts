import { homedir } from 'node:os'
import type { AgentFeatures, AppConfigSnapshot, AppProfile, EnvironmentContextSettings } from '@shared/types'
import { capabilityFeatures, defaultCapabilities } from '@shared/agentCapabilities'
import { getDataDir } from '../config/dataDir'

export type AgentSystemPromptSectionKind =
  | 'profile'
  | 'system_instruction'
  | 'runtime_context'
  | 'project_instruction'
  | 'coding_instruction'
  | 'workspace'
  | 'memory'
  | 'skills'

export interface AgentSystemPromptSection {
  kind: AgentSystemPromptSectionKind
  content: string
}

export interface AgentSystemPrompt {
  text: string
  sections: AgentSystemPromptSection[]
}

function buildCodingInstruction(features: AgentFeatures, toolsEnabled: boolean): string {
  return [
    '<coding_instruction>',
    'Coding mode is enabled. It changes your workflow, not your model, tools or access permissions.',
    'Understand the request and inspect the relevant project structure and files before proposing changes. Project AGENTS.md rules (AGENTS.override.md takes precedence in the same directory) are loaded as scoped, per-run snapshots. Apply deeper rules only to their directory trees. Structured file operations may return NOT EXECUTED when newly discovered rules require you to decide again; do not replay blindly or bypass the check through shell.',
    'Arbitrary shell commands do not have structured target preflight. Before using shell in a new directory, inspect it with structured file tools so applicable rules enter the system context. Read relevant rules for any other paths the command may affect; do not assume shell targets can be automatically inferred.',
    'Distinguish explanation, diagnosis and review from implementation. A review or analysis request does not authorize edits, commits or pushes.',
    'Inspect existing changes before editing and preserve user work. Fix the underlying cause, keep changes focused, and avoid unrelated refactors or compatibility code unless requested or required by the project.',
    ...(toolsEnabled && features.fileWrite ? ['Use the available editing tools for focused changes; inspect their results and handle conflicts without overwriting unrelated work.'] : []),
    ...(toolsEnabled && features.commandExecution ? ['Use the available command tools to inspect repository state and run the project\'s relevant tests, type checks and build. For visual changes, inspect the actual interface when possible.'] : []),
    ...(toolsEnabled && features.planning ? ['Use the available planning capability for multi-step work and update it as the task progresses.'] : []),
    ...(toolsEnabled && features.subagents ? ['Delegate only bounded independent work when useful; prevent overlapping writes and verify delegated results.'] : []),
    'Use only capabilities actually available in this run. If inspection, editing or validation is unavailable, explain the limitation; never bypass access controls or claim an action was performed.',
    'Review using concrete diffs and verified call relationships. Report actionable defects with evidence, not speculation or personal style preferences.',
    'At handoff, state what changed, what you actually verified, what remains unverified, and any blockers. Never report unrun tests as passing.',
    '</coding_instruction>'
  ].join('\n')
}

function operatingSystemName(): string {
  if (process.platform === 'darwin') return 'macOS'
  if (process.platform === 'win32') return 'Windows'
  return process.platform
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function profileField(name: string, value: string): string {
  return `<${name}>\n${escapeXml(value)}\n</${name}>`
}

export function buildProfileBlock(profile: AppProfile): string {
  return [
    '<profile>',
    '<assistant_profile>',
    profileField('name', profile.assistant.name),
    profileField('role', profile.assistant.role),
    profileField('instructions', profile.assistant.instructions),
    '</assistant_profile>',
    '<user_profile>',
    profileField('preferred_name', profile.user.preferredName),
    profileField('personal_info', profile.user.personalInfo),
    '</user_profile>',
    '</profile>'
  ].join('\n')
}

export function buildRuntimeContextBlock(
  context: EnvironmentContextSettings,
  commandShell?: string,
  commandToolsEnabled = false
): string {
  const now = new Date()
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0')
  ].join('-')
  const customInformation = context.customInformation.trim()
  const details = [
    ...(context.operatingSystem ? [`Operating system: ${operatingSystemName()}`] : []),
    ...(commandShell ? [`Command shell: ${commandShell}`] : []),
    ...(context.currentDate ? [`Current date: ${date}`] : []),
    ...(context.applicationDataDirectory ? [`Application data directory: ${getDataDir()}`] : []),
    ...(context.userHomeDirectory ? [`User home directory: ${homedir()}`] : []),
    ...(context.bundledCommands && commandToolsEnabled ? [
      'Bundled commands:',
      '- rg: ripgrep for text and file search; available on PATH.'
    ] : []),
    ...(context.customInformationEnabled && customInformation
      ? [escapeXml(customInformation)]
      : [])
  ]
  return details.length > 0 ? ['<environment>', ...details, '</environment>'].join('\n') : ''
}

export function buildAgentSystemPrompt(
  config: AppConfigSnapshot,
  context: {
    workspace: string
    memory: string
    skills: string
    commandShell?: string
    simpleChatPrompt?: string
    projectPrompt?: string
    codingMode?: boolean
    toolsEnabled?: boolean
  },
  features: AgentFeatures = capabilityFeatures(defaultCapabilities)
): AgentSystemPrompt {
  const sections: AgentSystemPromptSection[] = []
  const appendSection = (
    kind: AgentSystemPromptSectionKind,
    content: string
  ): void => {
    const trimmed = content.trim()
    if (trimmed) sections.push({ kind, content: trimmed })
  }

  if (context.simpleChatPrompt !== undefined) {
    appendSection('system_instruction', context.simpleChatPrompt)
    return {
      text: sections.map((section) => section.content).join('\n\n'),
      sections
    }
  }
  if (features.profile) appendSection('profile', buildProfileBlock(config.settings.profile))
  if (context.codingMode) appendSection('coding_instruction', buildCodingInstruction(features, context.toolsEnabled ?? true))
  if (features.environment) {
    appendSection('runtime_context', buildRuntimeContextBlock(
      config.settings.environmentContext,
      context.commandShell,
      (context.toolsEnabled ?? true) && features.commandExecution
    ))
  }
  if (context.projectPrompt?.trim()) appendSection('project_instruction', `<project_instruction>\n${context.projectPrompt.trim()}\n</project_instruction>`)
  if (features.workspaceContext) appendSection('workspace', context.workspace)
  if (features.memory) appendSection('memory', context.memory)
  if (features.skills) appendSection('skills', context.skills)
  return {
    text: sections.map((section) => section.content).join('\n\n'),
    sections
  }
}
