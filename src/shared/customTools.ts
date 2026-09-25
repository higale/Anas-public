import Ajv, { type AnySchema } from 'ajv/dist/2019'
import { isCommandShellToolName, maxCommandTimeoutSeconds } from './commandShell'
import defaults from '../../data/config/tools.json'
import { orderedToolCatalog } from './toolRegistry'

export interface CustomToolDefinition {
  id: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** A fixed executable and arguments; {{args}} is replaced after tokenization. */
  command: string
  timeoutSeconds: number
  interactive: boolean
  /** Project package location; user packages are located by ID at invocation. */
  directory?: string
}

export type CustomToolSave = Omit<CustomToolDefinition, 'id' | 'directory'> & { id?: string }
export const maxCustomToolInputBytes = 1024 * 1024
export const maxCustomToolOutputChars = 512 * 1024
export const customToolDefaults = {
  command: defaults.defaults.command,
  timeoutSeconds: defaults.defaults.timeout_seconds,
  interactive: defaults.defaults.interactive
}

const reservedNames = new Set<string>([...orderedToolCatalog.map((tool) => tool.id),
  'pwsh', 'powershell', 'bash', 'zsh', 'sh', 'cmd', 'task', 'ls', 'edit_file', 'execute'])
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true })

export function parseCustomToolCommand(command: string): { executable: string; args: string[] } {
  if (!command.trim() || command.length > 16384 || Array.from(command).some((character) => character < ' ' && !'\t\r\n'.includes(character))) {
    throw new Error('Command must contain an executable and arguments, at most 16384 characters.')
  }
  // This is literal argv syntax, not Shell syntax. One lexer both validates and
  // splits it: quotes group text, backslashes never escape, and adjacent quoted
  // and unquoted fragments form one argument. Shell parsers use different rules.
  const lexeme = /(\s+)|'([^']*)'|"([^"]*)"|([^\s'"]+)/y
  const words: string[] = []
  let word: string | undefined
  let offset = 0
  while (offset < command.length) {
    lexeme.lastIndex = offset
    const match = lexeme.exec(command)
    if (!match) throw new Error('Command contains an unclosed quote.')
    offset = lexeme.lastIndex
    if (match[1] !== undefined) {
      if (word !== undefined) words.push(word)
      word = undefined
    } else {
      if (match[4] !== undefined && /[|&;()<>#$`]/.test(match[4])) {
        throw new Error('Shell operators, variables and comments are not supported. Quote special characters to pass them literally.')
      }
      word = (word ?? '') + (match[2] ?? match[3] ?? match[4])
    }
  }
  if (word !== undefined) words.push(word)
  const [executable, ...args] = words
  if (!executable || executable.includes('{{args}}') || words.length > 129) throw new Error('Command must contain an executable and at most 128 arguments.')
  if (args.filter((arg) => arg === '{{args}}').length !== 1 || args.some((arg) => arg.includes('{{args}}') && arg !== '{{args}}')) {
    throw new Error('Command must contain exactly one standalone {{args}} argument for the model JSON.')
  }
  return { executable, args }
}

export function validateCustomToolSchema(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as Record<string, unknown>).type !== 'object') {
    throw new Error('Parameters must be a JSON Schema with type "object" (draft 2019-09).')
  }
  const schema = value as Record<string, unknown>
  if (JSON.stringify(schema).length > 64 * 1024) throw new Error('Parameter schema exceeds 64 KB.')
  if (schema.$schema !== undefined && schema.$schema !== 'https://json-schema.org/draft/2019-09/schema' && schema.$schema !== 'https://json-schema.org/draft/2019-09/schema#') {
    throw new Error('Parameter schema must use draft 2019-09, matching the tool runtime.')
  }
  // Compilation checks references and keyword shapes without invoking user code or fetching remote schemas.
  try { ajv.compile(schema as AnySchema) } finally { ajv.removeSchema(schema as AnySchema) }
  return structuredClone(schema)
}

export function validateCustomTool(value: unknown): CustomToolDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid custom tool.')
  const raw = value as Record<string, unknown>
  const text = (key: string, max: number) => {
    const v = raw[key]
    if (typeof v !== 'string' || !v.trim() || v.length > max || v.includes('\0')) throw new Error(`Invalid custom tool ${key}.`)
    return v.trim()
  }
  const name = text('name', 64)
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name) || reservedNames.has(name.toLowerCase()) || isCommandShellToolName(name) || /^(mcp_|__|anas_|code_review)/i.test(name)) {
    throw new Error('Tool name must start with a letter or underscore, use letters, digits, underscores or hyphens, and not use a reserved name.')
  }
  const command = text('command', 16384)
  parseCustomToolCommand(command)
  if (!Number.isInteger(raw.timeoutSeconds) || Number(raw.timeoutSeconds) < 0 || Number(raw.timeoutSeconds) > maxCommandTimeoutSeconds) throw new Error(`Timeout must be an integer from 0 to ${maxCommandTimeoutSeconds} seconds; 0 means no time limit.`)
  if (raw.interactive !== undefined && typeof raw.interactive !== 'boolean') throw new Error('Interactive terminal must be a boolean.')
  if (raw.directory !== undefined && (typeof raw.directory !== 'string' || !raw.directory || raw.directory.includes('\0'))) throw new Error('Invalid tool directory.')
  return { ...(raw.directory === undefined ? {} : { directory: raw.directory as string }), id: text('id', 256), name, description: text('description', 8192),
    inputSchema: validateCustomToolSchema(raw.inputSchema), command, timeoutSeconds: Number(raw.timeoutSeconds),
    interactive: raw.interactive ?? customToolDefaults.interactive }
}

export function validateCustomTools(value: unknown): CustomToolDefinition[] {
  if (!Array.isArray(value)) throw new Error('Custom tools must be an array.')
  const tools = value.map(validateCustomTool)
  if (new Set(tools.map((tool) => tool.id)).size !== tools.length || new Set(tools.map((tool) => tool.name.toLowerCase())).size !== tools.length) throw new Error('Custom tool IDs and names must be unique.')
  return tools
}

export function serializeCustomTool(tool: CustomToolDefinition) {
  const { inputSchema, timeoutSeconds, ...rest } = tool
  return { ...rest, input_schema: inputSchema, timeout_seconds: timeoutSeconds }
}

export function parseCustomTools(value: unknown): CustomToolDefinition[] {
  if (!Array.isArray(value)) throw new Error('Invalid custom tool configuration.')
  return validateCustomTools(value.map((raw) => ({ ...raw, inputSchema: raw.input_schema,
    timeoutSeconds: raw.timeout_seconds })))
}

export function isCustomToolMetadata(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'anasCustomToolId' in value && typeof value.anasCustomToolId === 'string')
}
