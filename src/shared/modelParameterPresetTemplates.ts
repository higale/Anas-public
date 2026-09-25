import rawParameterPresetTemplates from '../../data/config/model-parameter-preset-templates.json'
import type { ModelParameterPreset, ModelProtocol } from './types'
import { modelReservedParameterKeys } from './modelParameterValidation'

export interface ModelParameterPresetTemplate {
  id: string
  label: string
  parameters: Record<string, unknown>
}

export interface ModelParameterPresetTemplateGroup {
  type: 'templates'
  id: string
  label: string
  templates: ModelParameterPresetTemplate[]
}

export interface ModelParameterPresetTemplateFolder {
  type: 'group'
  id: string
  label: string
  children: ModelParameterPresetTemplateTreeNode[]
}

export type ModelParameterPresetTemplateTreeNode =
  | ModelParameterPresetTemplateGroup
  | ModelParameterPresetTemplateFolder

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bundled config value ${path} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Bundled config value ${path} must be a non-empty array.`)
  }
  return value
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Bundled config value ${path} must be a non-empty string.`)
  }
  return value.trim()
}

function parseTemplate(value: unknown, path: string, groupId: string): ModelParameterPresetTemplate {
  const template = requireRecord(value, path)
  const id = requireString(template.id, `${path}.id`)
  const parameters = requireRecord(template.parameters, `${path}.parameters`)
  const reserved = modelReservedParameterKeys(parameters)
  if (reserved.length > 0) {
    throw new Error(`Bundled config value ${path}.parameters contains reserved keys: ${reserved.join(', ')}.`)
  }
  return {
    id: `${groupId}/${id}`,
    label: requireString(template.label, `${path}.label`),
    parameters
  }
}

function parseNodes(values: unknown[], parentIds: string[], path: string): ModelParameterPresetTemplateTreeNode[] {
  const siblingIds = new Set<string>()
  return values.map((value, index) => {
    const nodePath = `${path}[${index}]`
    const node = requireRecord(value, nodePath)
    const id = requireString(node.id, `${nodePath}.id`)
    if (id.includes('/')) throw new Error(`Bundled config value ${nodePath}.id must not contain "/".`)
    if (siblingIds.has(id)) throw new Error(`Bundled config value ${path} contains duplicate id "${id}".`)
    siblingIds.add(id)
    const fullId = [...parentIds, id].join('/')
    const label = requireString(node.label, `${nodePath}.label`)
    const hasChildren = 'children' in node
    const hasTemplates = 'templates' in node
    if (hasChildren === hasTemplates) {
      throw new Error(`Bundled config value ${nodePath} must contain exactly one of children or templates.`)
    }
    if (hasChildren) {
      return {
        type: 'group',
        id: fullId,
        label,
        children: parseNodes(
          requireArray(node.children, `${nodePath}.children`),
          [...parentIds, id],
          `${nodePath}.children`
        )
      }
    }
    const templates = requireArray(node.templates, `${nodePath}.templates`)
      .map((template, templateIndex) => parseTemplate(
        template,
        `${nodePath}.templates[${templateIndex}]`,
        fullId
      ))
    if (new Set(templates.map((template) => template.id)).size !== templates.length) {
      throw new Error(`Bundled config value ${nodePath}.templates contains duplicate ids.`)
    }
    return { type: 'templates', id: fullId, label, templates }
  })
}

function flattenTemplateGroups(nodes: ModelParameterPresetTemplateTreeNode[]): ModelParameterPresetTemplateGroup[] {
  return nodes.flatMap((node) => node.type === 'templates'
    ? [node]
    : flattenTemplateGroups(node.children))
}

const root = requireRecord(rawParameterPresetTemplates, 'model_parameter_preset_templates')

export const modelParameterPresetTemplateTree = parseNodes(
  requireArray(root.groups, 'model_parameter_preset_templates.groups'),
  [],
  'model_parameter_preset_templates.groups'
)

export const modelParameterPresetTemplateGroups = flattenTemplateGroups(modelParameterPresetTemplateTree)

export function protocolDefaultModelParameterPresets(protocol: ModelProtocol): ModelParameterPreset[] {
  const group = modelParameterPresetTemplateGroups.find((candidate) => candidate.id === protocol)
  if (!group) throw new Error(`Bundled model parameter presets are missing for protocol "${protocol}".`)
  return group.templates.map((template) => ({
    id: template.id,
    name: template.label,
    parameters: template.parameters
  }))
}
