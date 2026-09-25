import rawModelTemplates from '../../data/config/model-templates.json'
import {
  defaultModelProviderConfig,
  modelReservedParameterKeys,
  requireModelListAuth,
  requireModelProtocol
} from './modelConfig'
import type { ModelProtocol, ModelProviderConfigSave } from './types'

export interface ModelProviderTemplate extends ModelProviderConfigSave {
  label: string
  templateId: string
  modelListUrl: string
}

export interface ModelTemplateGroupNode {
  type: 'group'
  id: string
  label: string
  children: ModelTemplateTreeNode[]
}

export interface ModelTemplateLeafNode {
  type: 'template'
  id: string
  label: string
  template: ModelProviderTemplate
}

export type ModelTemplateTreeNode = ModelTemplateGroupNode | ModelTemplateLeafNode

const modelTemplateConfigKeys = new Set([
  'name',
  'protocol',
  'base_url',
  'model_list_url',
  'model_list_auth',
  'parameters'
])

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bundled config value ${path} must be an object.`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Bundled config value ${path} must be an array.`)
  return value
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
    throw new Error(`Bundled config value ${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.`)
  }
  return value
}

function parseNodeId(value: unknown, path: string): string {
  const id = requireString(value, path).trim()
  if (id.includes('/')) throw new Error(`Bundled config value ${path} must not contain "/".`)
  return id
}

function parseTemplateConfig(
  value: unknown,
  path: string,
  templateId: string,
  label: string
): ModelProviderTemplate {
  const config = requireRecord(value, path)
  const unsupportedKeys = Object.keys(config).filter((key) => !modelTemplateConfigKeys.has(key)).sort()
  if (unsupportedKeys.length > 0) {
    throw new Error(`Bundled config value ${path} contains unsupported keys: ${unsupportedKeys.join(', ')}.`)
  }
  const parameters = config.parameters === undefined
    ? defaultModelProviderConfig.parameters
    : requireRecord(config.parameters, `${path}.parameters`)
  const reserved = modelReservedParameterKeys(parameters)
  if (reserved.length > 0) {
    throw new Error(`Bundled config value ${path}.parameters contains reserved keys: ${reserved.join(', ')}.`)
  }
  return {
    templateId,
    label,
    name: requireString(config.name, `${path}.name`),
    protocol: requireModelProtocol(config.protocol, `${path}.protocol`),
    baseUrl: requireString(config.base_url, `${path}.base_url`),
    modelListUrl: requireString(config.model_list_url, `${path}.model_list_url`),
    modelListAuth: requireModelListAuth(config.model_list_auth, `${path}.model_list_auth`),
    apiKey: '',
    parameters
  }
}

function parseTemplateNodes(values: unknown[], parentPath: string[], configPath: string): ModelTemplateTreeNode[] {
  if (values.length === 0) throw new Error(`Bundled config value ${configPath} must not be empty.`)
  const siblingIds = new Set<string>()
  return values.map((value, index) => {
    const path = `${configPath}[${index}]`
    const node = requireRecord(value, path)
    const id = parseNodeId(node.id, `${path}.id`)
    if (siblingIds.has(id)) throw new Error(`Bundled config value ${configPath} contains duplicate id "${id}".`)
    siblingIds.add(id)
    const label = requireString(node.label, `${path}.label`).trim()
    const templatePath = [...parentPath, id]
    if (node.type === 'group') {
      if ('config' in node) throw new Error(`Bundled config value ${path} cannot contain both config and children.`)
      return {
        type: 'group',
        id,
        label,
        children: parseTemplateNodes(
          requireArray(node.children, `${path}.children`),
          templatePath,
          `${path}.children`
        )
      }
    }
    if (node.type === 'template') {
      if ('children' in node) throw new Error(`Bundled config value ${path} cannot contain both config and children.`)
      return {
        type: 'template',
        id,
        label,
        template: parseTemplateConfig(node.config, `${path}.config`, templatePath.join('/'), label)
      }
    }
    throw new Error(`Bundled config value ${path}.type must be "group" or "template".`)
  })
}

function flattenTemplates(nodes: ModelTemplateTreeNode[]): ModelProviderTemplate[] {
  return nodes.flatMap((node) => (
    node.type === 'template' ? [node.template] : flattenTemplates(node.children)
  ))
}

const rawRoot = requireRecord(rawModelTemplates, 'model_templates')

export const modelTemplateTree = parseTemplateNodes(
  requireArray(rawRoot.templates, 'model_templates.templates'),
  [],
  'model_templates.templates'
)

export const modelTemplates = flattenTemplates(modelTemplateTree)

const modelTemplateById = new Map(modelTemplates.map((template) => [template.templateId, template]))

export function getModelTemplate(templateId: string): ModelProviderTemplate | undefined {
  return modelTemplateById.get(templateId)
}

function normalizeTemplateBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function findModelTemplate(protocol: ModelProtocol, baseUrl: string): ModelProviderTemplate | undefined {
  const normalizedBaseUrl = normalizeTemplateBaseUrl(baseUrl)
  if (!normalizedBaseUrl) return undefined
  return modelTemplates.find((template) => (
    template.protocol === protocol
    && normalizeTemplateBaseUrl(template.baseUrl) === normalizedBaseUrl
  ))
}
