import { defaultCapabilities, } from '@shared/agentCapabilities'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspaceProject } from '@shared/types'
import { resolveWorkspaceImagePath } from './workspaceImagePath'

const roots: string[] = []

function workspaceProject(sourceFolder: string): WorkspaceProject {
  return {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
    id: 'workspace-project',
    kind: 'workspace',
    name: 'Workspace',
    pinned: false,
    collapsed: false,
    sourceFolders: [sourceFolder],
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z'
  }
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('workspace Markdown image paths', () => {
  it('resolves relative images from the primary project folder', async () => {
    const root = await temporaryDirectory('anas-markdown-image-')
    const imagePath = join(root, 'images', 'avatar.png')
    await mkdir(join(root, 'images'))
    await writeFile(imagePath, 'image')

    await expect(resolveWorkspaceImagePath('images/avatar.png', workspaceProject(root)))
      .resolves.toBe(await realpath(imagePath))
  })

  it('does not resolve relative images without a workspace project', async () => {
    await expect(resolveWorkspaceImagePath('avatar.png')).resolves.toBeUndefined()
  })

  it('rejects relative paths that escape the primary project folder', async () => {
    const parent = await temporaryDirectory('anas-markdown-parent-')
    const root = join(parent, 'workspace')
    await mkdir(root)
    await writeFile(join(parent, 'outside.png'), 'outside')

    await expect(resolveWorkspaceImagePath('../outside.png', workspaceProject(root)))
      .rejects.toThrow('must stay inside the primary project folder')
  })

  it.skipIf(process.platform === 'win32')('rejects a workspace symlink whose target is outside', async () => {
    const root = await temporaryDirectory('anas-markdown-link-root-')
    const outside = await temporaryDirectory('anas-markdown-link-outside-')
    const target = join(outside, 'outside.png')
    await writeFile(target, 'outside')
    await symlink(target, join(root, 'linked.png'))

    await expect(resolveWorkspaceImagePath('linked.png', workspaceProject(root)))
      .rejects.toThrow('must stay inside the primary project folder')
  })
})
