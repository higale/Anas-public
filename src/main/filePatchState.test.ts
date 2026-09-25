import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveFilePatchTargets, planFilePatch } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages, verifyFilePatchPreimages } from './filePatchState'

const temporary: string[] = []
async function directory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'anas-patch-state-')))
  temporary.push(path)
  return path
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

describe('patch target preimages', () => {
  it('captures existing/absent targets and preserves BOM, hash, permissions and file identity', async () => {
    const root = await directory()
    const text = '\ufeff中文\r\n原文\r\n'
    await writeFile(join(root, 'old.txt'), text)
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
      { type: 'move', path: 'old.txt', destination: 'new/moved.txt' },
      { type: 'create', path: 'empty.txt', content: '' }
    ] }), root)
    const preimages = await captureFilePatchPreimages(resolved.targets)
    const info = await lstat(join(root, 'old.txt'), { bigint: true })
    expect(preimages[0]).toMatchObject({
      text, hash: createHash('sha256').update(text).digest('hex'),
      identity: { device: String(info.dev), inode: String(info.ino), mode: Number(info.mode), size: Buffer.byteLength(text) }
    })
    expect(preimages[1]).toMatchObject({ text: null, hash: null, identity: null, parent: { path: root } })
    expect(preimages[2]).toMatchObject({ text: null, hash: null, identity: null })
    const snapshots = new Map(preimages.map((preimage) => [preimage.target.canonicalPath, preimage.text]))
    expect(planFilePatch(resolved.input, snapshots)).toHaveLength(3)
    await expect(lstat(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(root, 'empty.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe(text)
    await expect(verifyFilePatchPreimages(preimages)).resolves.toBeUndefined()
  })

  it('does not confuse an empty existing file with a missing file', async () => {
    const root = await directory()
    await writeFile(join(root, 'empty.txt'), '')
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'delete', path: 'empty.txt' }] }), root)
    const [preimage] = await captureFilePatchPreimages(resolved.targets)
    expect(preimage.text).toBe('')
    expect(preimage.identity?.size).toBe(0)
    expect(preimage.hash).toBe(createHash('sha256').update('').digest('hex'))
  })

  it.each(['overwrite', 'remove', 'replace'])('rejects a target %s after capture', async (action) => {
    const root = await directory()
    const path = join(root, 'file.txt')
    await writeFile(path, 'before')
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'delete', path }] }), root)
    const preimages = await captureFilePatchPreimages(resolved.targets)
    if (action === 'overwrite') await writeFile(path, 'AFTER!')
    else if (action === 'remove') await rm(path)
    else {
      await writeFile(join(root, 'replacement.txt'), 'before')
      await rename(join(root, 'replacement.txt'), path)
    }
    await expect(verifyFilePatchPreimages(preimages)).rejects.toThrow('changed')
  })

  it('rejects creation of a target that was absent in the captured state', async () => {
    const root = await directory()
    const path = join(root, 'new.txt')
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path, content: 'new' }] }), root)
    const preimages = await captureFilePatchPreimages(resolved.targets)
    await writeFile(path, 'user file')
    await expect(verifyFilePatchPreimages(preimages)).rejects.toThrow('changed')
    expect(await readFile(path, 'utf8')).toBe('user file')
  })

  it('rejects an ancestor replaced at the same path even when the target stays absent', async () => {
    const root = await directory()
    const parent = join(root, 'parent')
    await mkdir(parent)
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: join(parent, 'new.txt'), content: '' }] }), root)
    const preimages = await captureFilePatchPreimages(resolved.targets)
    await rename(parent, join(root, 'old-parent'))
    await mkdir(parent)
    await expect(verifyFilePatchPreimages(preimages)).rejects.toThrow('changed')
  })

  it('rejects a parent link retargeted after path resolution', async () => {
    const root = await directory()
    await mkdir(join(root, 'one'))
    await mkdir(join(root, 'two'))
    const link = join(root, 'link')
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    await symlink(join(root, 'one'), link, type)
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: 'link/new.txt', content: '' }] }), root)
    await rm(link)
    await symlink(join(root, 'two'), link, type)
    await expect(captureFilePatchPreimages(resolved.targets)).rejects.toThrow('changed')
  })

  it.each([
    { name: 'NUL', bytes: Buffer.from([65, 0, 66]) },
    { name: 'invalid UTF-8', bytes: Buffer.from([0xc3, 0x28]) },
    { name: 'oversized', bytes: Buffer.alloc(1_000_001, 65) }
  ])('rejects $name input before planning', async ({ bytes }) => {
    const root = await directory()
    const path = join(root, 'bad.txt')
    await writeFile(path, bytes)
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'delete', path }] }), root)
    await expect(captureFilePatchPreimages(resolved.targets)).rejects.toThrow()
    expect(await readFile(path)).toEqual(bytes)
  })

  it('rejects directory targets and invalid target counts', async () => {
    const root = await directory()
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'delete', path: root }] }), root)
    await expect(captureFilePatchPreimages(resolved.targets)).rejects.toThrow('regular text file')
    await expect(captureFilePatchPreimages([])).rejects.toThrow('target count')
    await expect(captureFilePatchPreimages(Array(41).fill(resolved.targets[0]))).rejects.toThrow('target count')
  })

  it('checks the batch byte budget before allocating another file buffer', async () => {
    const root = await directory()
    const operations: Parameters<typeof asPatchInput>[0]['operations'] = []
    for (let index = 0; index < 5; index++) {
      const path = join(root, `${index}.txt`)
      await writeFile(path, 'a'.repeat(900_000))
      operations.push({ type: 'delete', path })
    }
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations }), root)
    await expect(captureFilePatchPreimages(resolved.targets)).rejects.toThrow('remaining byte budget')
  })

  it('honors cancellation during capture and subsequent verification', async () => {
    const root = await directory()
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: 'new.txt', content: '' }] }), root)
    const preimages = await captureFilePatchPreimages(resolved.targets)
    const control = new AbortController()
    control.abort(new Error('cancel patch capture'))
    await expect(captureFilePatchPreimages(resolved.targets, control.signal)).rejects.toThrow('cancel patch capture')
    await expect(verifyFilePatchPreimages(preimages, control.signal)).rejects.toThrow('cancel patch capture')
  })

  it.skipIf(process.platform === 'win32')('rejects changed POSIX permissions before submission', async () => {
    const root = await directory()
    const path = join(root, 'file.txt')
    await writeFile(path, 'before', { mode: 0o644 })
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'delete', path }] }), root)
    const preimages = await captureFilePatchPreimages(resolved.targets)
    await chmod(path, 0o600)
    await expect(verifyFilePatchPreimages(preimages)).rejects.toThrow('changed')
  })
})
