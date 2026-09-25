import { isAbsolute } from 'node:path'
import type { Project } from '@shared/types'
import { isSameOrInsideDirectory } from './pathContainment'
import { canonicalizeAbsolutePath, resolveCanonicalWorkspacePath } from './workspacePath'

export async function resolveWorkspaceImagePath(
  filePath: string,
  project?: Project
): Promise<string | undefined> {
  if (isAbsolute(filePath)) return filePath
  if (project?.kind !== 'workspace') return undefined
  const primaryFolder = project.sourceFolders[0]
  if (!primaryFolder) return undefined
  const [root, target] = await Promise.all([
    canonicalizeAbsolutePath(primaryFolder, 'follow'),
    resolveCanonicalWorkspacePath(filePath, primaryFolder, 'follow')
  ])
  if (!isSameOrInsideDirectory(root.canonicalPath, target.canonicalPath)) {
    throw new Error('Relative image path must stay inside the primary project folder.')
  }
  return target.canonicalPath
}
