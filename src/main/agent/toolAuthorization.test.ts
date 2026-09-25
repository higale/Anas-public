import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  approvalToolNames,
  prepareToolPathAuthorization,
  requiresToolApproval
} from './toolAuthorization'

describe('tool authorization', () => {
  it.each(['strict_approval', 'read_only_allowed', 'full_access'] as const)('authorizes terminal input independently of the original command in %s', async (accessMode) => {
    expect(approvalToolNames()).toContain('write_call')
    for (const action of [{ type: 'text', text: 'a new command\r' }, { type: 'key', key: 'enter' }, { type: 'eof' }]) {
      expect(await requiresToolApproval({ toolName: 'write_call', args: { action }, accessMode,
        primaryFolder: process.cwd(), trustedFolders: [] })).toBe(accessMode !== 'full_access')
    }
    expect(await requiresToolApproval({ toolName: 'write_call', args: { action: { type: 'resize', columns: 100, rows: 30 } },
      accessMode, primaryFolder: process.cwd(), trustedFolders: [] })).toBe(false)
  })
  const temporaryRoots: string[] = []

  async function temporaryDirectory(prefix: string): Promise<string> {
    const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
    temporaryRoots.push(path)
    return path
  }

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it('registers each approval policy exactly once', () => {
    const names = approvalToolNames('pwsh')
    expect(new Set(names).size).toBe(names.length)
    expect(names).toContain('pwsh')
    expect(names).toContain('update_config')
    expect(names).toContain('apply_patch')
  })

  it.each(['strict_approval', 'read_only_allowed', 'full_access'] as const)('checks every patch target in %s without rewriting lexical arguments', async (accessMode) => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const args = { summary: 'Edit files', patch: `*** Begin Patch\n*** Add File: 新建 file.txt\n*** Update File: update.txt\n@@\n-before\n+after\n*** Delete File: delete.txt\n*** Update File: source.txt\n*** Move to: ${join(outside, 'target.txt')}\n*** End Patch` }
    const original = structuredClone(args)
    const result = await prepareToolPathAuthorization({ toolName: 'apply_patch', args,
      primaryFolder: primary, trustedFolders: [primary], accessMode })
    expect(result.requiresApproval).toBe(accessMode !== 'full_access')
    expect(result.targets.map((target) => target.locator)).toEqual([
      ['operations', 0, 'path'], ['operations', 1, 'path'], ['operations', 2, 'path'],
      ['operations', 3, 'path'], ['operations', 3, 'destination']
    ])
    expect(result.targets.map((target) => target.access)).toEqual(Array(5).fill('write'))
    expect(args).toEqual(original)
    const local = structuredClone(args)
    local.patch = local.patch.replace(join(outside, 'target.txt'), 'target.txt')
    expect((await prepareToolPathAuthorization({ toolName: 'apply_patch', args: local,
      primaryFolder: primary, trustedFolders: [primary], accessMode })).requiresApproval).toBe(false)
  })

  it.each(['create', 'delete', 'move', 'update'])('uses the correct link semantics for patch %s', async (type) => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    await writeFile(join(outside, 'target'), 'before\n')
    await symlink(join(outside, 'target'), join(primary, 'link'), 'file')
    const body = type === 'create' ? '*** Add File: link\n+text' : type === 'delete' ? '*** Delete File: link'
      : type === 'move' ? '*** Update File: link\n*** Move to: moved' : '*** Update File: link\n@@\n-before\n+after'
    const args = { summary: 'Edit link', patch: `*** Begin Patch\n${body}\n*** End Patch` }
    const result = await prepareToolPathAuthorization({ toolName: 'apply_patch', args,
      primaryFolder: primary, trustedFolders: [primary], accessMode: 'strict_approval' })
    expect(result.targets[0].canonicalPath).toBe(join(type === 'update' ? outside : primary, type === 'update' ? 'target' : 'link'))
    expect(result.requiresApproval).toBe(type === 'update')
    expect(args.patch).toBe(`*** Begin Patch\n${body}\n*** End Patch`)
  })

  it('rejects malformed and overlapping patch batches even with full access', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    for (const patch of ['*** Begin Patch\n*** End Patch', '*** Begin Patch\n*** Unknown File: a\n*** End Patch',
      '*** Begin Patch\n*** Update File: a\n*** Move to: a\n*** End Patch',
      '*** Begin Patch\n*** Delete File: parent\n*** Add File: parent/child\n*** End Patch']) {
      await expect(prepareToolPathAuthorization({ toolName: 'apply_patch', args: { summary: 'Edit', patch },
        primaryFolder: primary, trustedFolders: [primary], accessMode: 'full_access' })).rejects.toThrow()
    }
  })

  it.each(['strict_approval', 'read_only_allowed', 'full_access'] as const)('authorizes a dry run as a read in %s', async (accessMode) => {
    const primary = await temporaryDirectory('anas-auth-primary-'), outside = await temporaryDirectory('anas-auth-outside-')
    const args = { dry_run: true, patch: `*** Begin Patch\n*** Update File: ${join(outside, 'source.txt')}\n*** Move to: ${join(outside, 'target.txt')}\n@@\n-before\n+after\n*** End Patch` }
    const result = await prepareToolPathAuthorization({ toolName: 'apply_patch', args,
      primaryFolder: primary, trustedFolders: [primary], accessMode })
    expect(result.requiresApproval).toBe(accessMode === 'strict_approval')
    expect(result.targets.map((target) => target.access)).toEqual(['read', 'read'])
    expect(args).not.toHaveProperty('operations')
  })

  it.each(['view_image', 'view_multiple_images'])('applies file-read authorization and canonical targets to %s', async (toolName) => {
    const primary = await temporaryDirectory('anas-image-primary-')
    const outside = await temporaryDirectory('anas-image-outside-')
    const path = join(outside, 'image.png')
    await writeFile(path, 'image')
    const args = toolName === 'view_image' ? { path } : { paths: [join(primary, 'local.png'), path] }
    for (const accessMode of ['strict_approval', 'read_only_allowed', 'full_access'] as const) {
      const result = await prepareToolPathAuthorization({ toolName, args, primaryFolder: primary, trustedFolders: [primary], accessMode })
      expect(result.requiresApproval).toBe(accessMode === 'strict_approval')
      expect(result.targets.at(-1)).toMatchObject({ canonicalPath: path, access: 'read' })
    }
  })

  it('reviews application configuration changes until full access is granted', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const base = {
      toolName: 'update_config',
      args: { config: 'settings', key: 'theme', value: 'dark' },
      primaryFolder: primary,
      trustedFolders: [primary]
    }

    await expect(requiresToolApproval({
      ...base,
      accessMode: 'strict_approval'
    })).resolves.toBe(true)
    await expect(requiresToolApproval({
      ...base,
      accessMode: 'read_only_allowed'
    })).resolves.toBe(true)
    await expect(requiresToolApproval({
      ...base,
      accessMode: 'full_access'
    })).resolves.toBe(false)
  })

  it('allows canonical targets inside every project folder and reviews outside targets', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const secondary = await temporaryDirectory('anas-auth-secondary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const insideArgs = { path: join(secondary, 'notes.txt') }
    const outsideArgs = { path: join(outside, 'notes.txt') }
    await writeFile(outsideArgs.path, 'outside', 'utf8')

    await expect(requiresToolApproval({
      toolName: 'delete_file',
      args: insideArgs,
      primaryFolder: primary,
      trustedFolders: [primary, secondary],
      accessMode: 'strict_approval'
    })).resolves.toBe(false)
    await expect(requiresToolApproval({
      toolName: 'read_file',
      args: outsideArgs,
      primaryFolder: primary,
      trustedFolders: [primary, secondary],
      accessMode: 'strict_approval'
    })).resolves.toBe(true)
  })

  it('allows reads outside projects but reviews outside writes in the default mode', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const outsideFile = join(outside, 'notes.txt')
    await writeFile(outsideFile, 'outside', 'utf8')

    await expect(requiresToolApproval({
      toolName: 'read_file',
      args: { path: outsideFile },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'read_only_allowed'
    })).resolves.toBe(false)
    await expect(requiresToolApproval({
      toolName: 'list_directory',
      args: { path: outside },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'read_only_allowed'
    })).resolves.toBe(false)
    await expect(requiresToolApproval({
      toolName: 'delete_file',
      args: { path: outsideFile, content: 'changed' },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'read_only_allowed'
    })).resolves.toBe(true)
  })

  it('reviews every shell command until full access is granted', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')

    await expect(requiresToolApproval({
      toolName: 'pwsh',
      args: { command: 'pwd' },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'strict_approval',
      commandShellToolName: 'pwsh'
    })).resolves.toBe(true)
    await expect(requiresToolApproval({
      toolName: 'pwsh',
      args: { command: 'pwd' },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'full_access',
      commandShellToolName: 'pwsh'
    })).resolves.toBe(false)
  })

  it('uses full access for canonical host paths', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const args = { path: join(outside, 'notes.txt') }
    await writeFile(args.path, 'outside', 'utf8')

    await expect(requiresToolApproval({
      toolName: 'read_file',
      args,
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'full_access'
    })).resolves.toBe(false)
  })

  it('resolves relative paths from the primary folder before authorization', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const insideArgs = { path: join('src', 'main.ts') }

    await expect(requiresToolApproval({
      toolName: 'delete_file',
      args: insideArgs,
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'strict_approval'
    })).resolves.toBe(false)
    expect(insideArgs.path).toBe(join(primary, 'src', 'main.ts'))

    await expect(requiresToolApproval({
      toolName: 'delete_file',
      args: { path: join(outside, 'outside.txt') },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'strict_approval'
    })).resolves.toBe(true)
  })

  it('canonicalizes an intermediate symlink or junction before deciding scope', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const link = join(primary, 'linked')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(outside, 'read.txt'), 'outside', 'utf8')

    const readArgs = { path: join(link, 'read.txt') }
    const writeArgs = { path: join(link, 'write.txt') }
    await expect(requiresToolApproval({
      toolName: 'read_file',
      args: readArgs,
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'strict_approval'
    })).resolves.toBe(true)
    await expect(requiresToolApproval({
      toolName: 'delete_file',
      args: writeArgs,
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'strict_approval'
    })).resolves.toBe(true)
    expect(readArgs.path).toBe(join(outside, 'read.txt'))
    expect(writeArgs.path).toBe(join(outside, 'write.txt'))
  })

  it.skipIf(process.platform === 'win32')('follows a final symlink for reads and writes while delete targets the link entry', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const target = join(outside, 'target.txt')
    const link = join(primary, 'linked.txt')
    await writeFile(target, 'outside', 'utf8')
    await symlink(target, link, 'file')

    const readArgs = { path: link }
    const writeArgs = { patch: `*** Begin Patch\n*** Update File: ${link}\n@@\n-outside\n+new\n*** End Patch` }
    const deleteArgs = { path: link }
    await expect(requiresToolApproval({
      toolName: 'read_file', args: readArgs, primaryFolder: primary,
      trustedFolders: [primary], accessMode: 'strict_approval'
    })).resolves.toBe(true)
    await expect(requiresToolApproval({
      toolName: 'apply_patch', args: writeArgs, primaryFolder: primary,
      trustedFolders: [primary], accessMode: 'strict_approval'
    })).resolves.toBe(true)
    await expect(requiresToolApproval({
      toolName: 'delete_file', args: deleteArgs, primaryFolder: primary,
      trustedFolders: [primary], accessMode: 'strict_approval'
    })).resolves.toBe(false)
    expect(readArgs.path).toBe(target)
    expect(writeArgs.patch).toContain(`*** Update File: ${link}\n`)
    expect(deleteArgs.path).toBe(link)
  })

  it.runIf(process.platform === 'win32')('follows a final directory junction for listing while delete targets the junction entry', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const junction = join(primary, 'linked')
    await symlink(outside, junction, 'junction')
    const listArgs = { path: junction }
    const deleteArgs = { path: junction }

    await expect(requiresToolApproval({
      toolName: 'list_directory', args: listArgs, primaryFolder: primary,
      trustedFolders: [primary], accessMode: 'strict_approval'
    })).resolves.toBe(true)
    await expect(requiresToolApproval({
      toolName: 'delete_file', args: deleteArgs, primaryFolder: primary,
      trustedFolders: [primary], accessMode: 'strict_approval'
    })).resolves.toBe(false)
    expect(listArgs.path).toBe(outside)
    expect(deleteArgs.path).toBe(junction)
  })

  it('binds execution to the authorized target when the original directory link changes', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const firstOutside = await temporaryDirectory('anas-auth-first-')
    const secondOutside = await temporaryDirectory('anas-auth-second-')
    const link = join(primary, 'linked')
    await symlink(firstOutside, link, process.platform === 'win32' ? 'junction' : 'dir')
    const args = { path: join(link, 'target.txt') }

    const authorization = await prepareToolPathAuthorization({
      toolName: 'delete_file',
      args,
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'strict_approval'
    })
    expect(authorization.requiresApproval).toBe(true)
    expect(args.path).toBe(join(firstOutside, 'target.txt'))

    await rm(link, { recursive: true })
    await symlink(secondOutside, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(args.path).toBe(join(firstOutside, 'target.txt'))
  })

  it('canonicalizes every optional local path used by http_request with operation-specific semantics', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const link = join(primary, 'linked')
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    await writeFile(join(outside, 'payload.json'), '{}', 'utf8')
    const args = {
      url: 'https://example.com',
      body_file: join(link, 'payload.json'),
      form_files: [{ field: 'document', path: join(link, 'payload.json') }],
      output_path: join(link, 'result.bin')
    }

    await expect(requiresToolApproval({
      toolName: 'http_request',
      args,
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'strict_approval'
    })).resolves.toBe(true)
    expect(args.body_file).toBe(join(outside, 'payload.json'))
    expect(args.form_files[0].path).toBe(join(outside, 'payload.json'))
    expect(args.output_path).toBe(join(outside, 'result.bin'))

    await expect(requiresToolApproval({
      toolName: 'http_request',
      args: { url: 'https://example.com' },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'strict_approval'
    })).resolves.toBe(false)
  })

  it('distinguishes outside HTTP input reads from output writes in the default mode', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    const outside = await temporaryDirectory('anas-auth-outside-')
    const payload = join(outside, 'payload.json')
    await writeFile(payload, '{}', 'utf8')

    await expect(requiresToolApproval({
      toolName: 'http_request',
      args: { url: 'https://example.com', body_file: payload },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'read_only_allowed'
    })).resolves.toBe(false)
    await expect(requiresToolApproval({
      toolName: 'http_request',
      args: { url: 'https://example.com', output_path: join(outside, 'result.bin') },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'read_only_allowed'
    })).resolves.toBe(true)
  })

  it('rejects malformed path collections before approval or execution', async () => {
    const primary = await temporaryDirectory('anas-auth-primary-')
    await expect(requiresToolApproval({
      toolName: 'http_request',
      args: { url: 'https://example.com', form_files: [{ field: 'document' }] },
      primaryFolder: primary,
      trustedFolders: [primary],
      accessMode: 'strict_approval'
    })).rejects.toThrow('Invalid file path arguments')
  })
})
