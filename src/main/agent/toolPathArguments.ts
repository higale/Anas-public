import type { WorkspacePathSemantics } from '../workspacePath'
import { filePatchPathArguments, parseFilePatch, parseWriteFile } from '../filePatch'

export type ToolArgumentLocatorSegment = string | number
type ToolPathPatternSegment = string | '*'

interface ToolPathDescriptor {
  pattern: readonly ToolPathPatternSegment[]
  semantics: WorkspacePathSemantics
  access: 'read' | 'write'
  optional?: boolean
}

export interface ToolPathArgument {
  // Identifies a parsed target; apply_patch locators address its internal plan,
  // not properties in the model's public { patch } arguments.
  locator: ToolArgumentLocatorSegment[]
  value: unknown
  semantics: WorkspacePathSemantics
  access: 'read' | 'write'
}

export const toolPathDescriptors: Readonly<Record<string, readonly ToolPathDescriptor[]>> = {
  apply_patch: [], // Paths are parsed from the public context patch below.
  write_file: [], // The shared transaction plan binds the public path below.
  view_image: [{ pattern: ['path'], semantics: 'follow', access: 'read' }],
  view_multiple_images: [{ pattern: ['paths', '*'], semantics: 'follow', access: 'read' }],
  read_file: [{ pattern: ['path'], semantics: 'follow', access: 'read' }],
  read_multiple_files: [{ pattern: ['paths', '*'], semantics: 'follow', access: 'read' }],
  restore_file_edit: [], // The host resolves all targets from the recorded batch.
  create_directory: [{ pattern: ['path'], semantics: 'entry', access: 'write' }],
  list_directory: [{ pattern: ['path'], semantics: 'follow', access: 'read' }],
  directory_tree: [{ pattern: ['path'], semantics: 'entry', access: 'read' }],
  move_file: [
    { pattern: ['source'], semantics: 'entry', access: 'write' },
    { pattern: ['destination'], semantics: 'entry', access: 'write' }
  ],
  delete_file: [{ pattern: ['path'], semantics: 'entry', access: 'write' }],
  get_file_info: [{ pattern: ['path'], semantics: 'entry', access: 'read' }],
  http_request: [
    { pattern: ['body_file'], semantics: 'follow', access: 'read', optional: true },
    { pattern: ['form_files', '*', 'path'], semantics: 'follow', access: 'read', optional: true },
    { pattern: ['output_path'], semantics: 'follow', access: 'write', optional: true }
  ]
}

function collectPatternValues(
  value: unknown,
  pattern: readonly ToolPathPatternSegment[],
  locator: ToolArgumentLocatorSegment[],
  semantics: WorkspacePathSemantics,
  access: 'read' | 'write'
): ToolPathArgument[] | undefined {
  if (pattern.length === 0) return [{ locator, value, semantics, access }]
  const [segment, ...rest] = pattern
  if (segment === '*') {
    if (!Array.isArray(value)) return undefined
    const values: ToolPathArgument[] = []
    for (const [index, item] of value.entries()) {
      const nested = collectPatternValues(item, rest, [...locator, index], semantics, access)
      if (!nested) return undefined
      values.push(...nested)
    }
    return values
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!(segment in record)) return undefined
  return collectPatternValues(record[segment], rest, [...locator, segment], semantics, access)
}

export function toolPathArguments(
  toolName: string,
  args: Record<string, unknown>
): ToolPathArgument[] | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  if (toolName === 'apply_patch' || toolName === 'write_file') {
    try {
      return filePatchPathArguments(toolName === 'write_file' ? parseWriteFile(args) : parseFilePatch(args)).map(({ operationIndex, field, value, semantics, access }) => ({
        locator: ['operations', operationIndex, field], value, semantics, access
      }))
    } catch { return undefined }
  }
  const descriptors = toolPathDescriptors[toolName]
  if (!descriptors) return []
  const values: ToolPathArgument[] = []
  for (const descriptor of descriptors) {
    const first = descriptor.pattern[0]
    if (descriptor.optional && typeof first === 'string' && !(first in args)) continue
    const matches = collectPatternValues(
      args,
      descriptor.pattern,
      [],
      descriptor.semantics,
      descriptor.access
    )
    if (!matches) return undefined
    values.push(...matches)
  }
  return values
}
