import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { canonicalAgentToolEffectJson } from './toolEffectMiddleware'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { projectInterruptPathPreviews } from './approvalPathPreview'

describe('approval path previews', () => {
  it('projects the default and relative working directories for shell approval', async () => {
    const primaryFolder = await realpath(process.cwd())
    const value = {
      actionRequests: [{
        name: 'pwsh',
        args: { command: 'pwd' }
      }, {
        name: 'pwsh',
        args: { command: 'pwd', working_dir: 'src' }
      }]
    }
    const [interrupt] = await projectInterruptPathPreviews([{
      id: 'approval',
      value,
      approvalGeneration: 'generation'
    }], primaryFolder)

    expect(interrupt.value).toBe(value)
    expect(interrupt.pathPreviews).toEqual([{
      actionIndex: 0,
      locator: ['working_dir'],
      absolutePath: primaryFolder,
      source: 'default'
    }, {
      actionIndex: 1,
      locator: ['working_dir'],
      absolutePath: resolve(primaryFolder, 'src'),
      source: 'relative'
    }])
  })

  it('projects nested http_request file paths without changing tool arguments', async () => {
    const primaryFolder = process.platform === 'win32' ? 'C:\\projects\\anas' : '/projects/anas'
    const value = {
      actionRequests: [{
        name: 'http_request',
        args: {
          url: 'https://example.com',
          body_file: 'input.json',
          form_files: [{ field: 'asset', path: 'images/source.png' }],
          output_path: 'downloads/result.bin'
        }
      }]
    }
    const [interrupt] = await projectInterruptPathPreviews([{
      id: 'approval',
      value,
      approvalGeneration: 'generation'
    }], primaryFolder)

    expect(interrupt.value).toBe(value)
    expect(interrupt.pathPreviews).toEqual([{
      actionIndex: 0,
      locator: ['body_file'],
      absolutePath: resolve(primaryFolder, 'input.json'),
      source: 'relative'
    }, {
      actionIndex: 0,
      locator: ['form_files', 0, 'path'],
      absolutePath: resolve(primaryFolder, 'images/source.png'),
      source: 'relative'
    }, {
      actionIndex: 0,
      locator: ['output_path'],
      absolutePath: resolve(primaryFolder, 'downloads/result.bin'),
      source: 'relative'
    }])
  })

  it('projects the authoritative resolved path for a cross-request file restore', async () => {
    const primaryFolder = process.platform === 'win32' ? 'C:\\projects\\anas' : '/projects/anas'
    const resolvedPath = process.platform === 'win32'
      ? 'C:\\outside\\recovered.txt'
      : '/outside/recovered.txt'
    const value = {
      actionRequests: [{
        name: 'restore_file_edit',
        args: {
          operation_id: 'operation-1',
          request_id: 'origin-request'
        }
      }]
    }
    const [interrupt] = await projectInterruptPathPreviews([{
      id: 'approval',
      value,
      approvalGeneration: 'generation'
    }], primaryFolder, { anasPatchAuthorization: { runId: 'run', calls: [{
      id: 'call', name: 'restore_file_edit', inputHash: createHash('sha256').update(canonicalAgentToolEffectJson(value.actionRequests[0].args)).digest('hex'),
      targets: [{ path: resolvedPath, lexicalPath: resolvedPath, locator: ['targets', 0, 'path'], kind: 'file', access: 'write' }], requiresApproval: true, humanApproved: false
    }] } })

    expect(interrupt.value).toBe(value)
    expect(interrupt.pathPreviews).toEqual([{
      actionIndex: 0,
      locator: ['targets', 0, 'path'],
      absolutePath: resolvedPath,
      source: 'resolved'
    }])
  })

  it.each(['apply_patch', 'write_file'])('projects %s transaction paths without rewriting public arguments', async (name) => {
    const primaryFolder = await realpath(process.cwd()), resolvedPath = resolve(primaryFolder, 'src/new.txt')
    const args = name === 'write_file' ? { path: 'src/new.txt', content: 'new' }
      : { patch: '*** Begin Patch\n*** Add File: src/new.txt\n+new\n*** End Patch' }
    const value = { actionRequests: [{ name, args }] }
    const [interrupt] = await projectInterruptPathPreviews([{ id: 'approval', approvalGeneration: 'generation', value }], primaryFolder,
      { anasPatchAuthorization: { runId: 'run', calls: [{ id: 'call', name,
        inputHash: createHash('sha256').update(canonicalAgentToolEffectJson(args)).digest('hex'), requiresApproval: true, humanApproved: false,
        targets: [{ path: resolvedPath, lexicalPath: resolvedPath, locator: ['operations', 0, 'path'], kind: 'file', access: 'write' }]
      }] } })
    expect(interrupt.value).toBe(value)
    expect(interrupt.pathPreviews).toEqual([{ actionIndex: 0, locator: name === 'write_file' ? ['path'] : ['operations', 0, 'path'], absolutePath: resolvedPath, source: 'relative' }])
    expect(args).not.toHaveProperty('operations')
  })
})
