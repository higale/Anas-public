import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import type {
  AgentAttachmentArtifact,
  AgentAttachmentInput
} from '@shared/agentTypes'
import { getAgentAttachmentsDir } from '../config/dataDir'
import { withApplicationDataMutation } from '../applicationDataSnapshot'

export interface ArchivedAgentAttachment {
  artifact: AgentAttachmentArtifact
  storagePath: string
}

function normalizedStoragePath(root: string, path: string): string {
  const rel = relative(resolve(root), resolve(path))
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error('Attachment storage path escaped the managed attachment directory.')
  }
  return rel.split(sep).join('/')
}

function storedFileName(sourcePath: string): string {
  const extension = extname(sourcePath)
  return /^\.[a-zA-Z0-9]{1,16}$/.test(extension)
    ? `content${extension.toLowerCase()}`
    : 'content'
}

async function archiveOne(
  input: AgentAttachmentInput,
  context: { threadId: string; runId: string; messageId: string },
  root: string
): Promise<ArchivedAgentAttachment> {
  const sourcePath = resolve(input.path)
  const sourceInfo = await stat(sourcePath)
  if (!sourceInfo.isFile()) throw new Error(`Attachment "${input.name}" is not a file.`)
  const id = randomUUID()
  const threadRoot = join(root, context.threadId)
  const temporaryDirectory = join(threadRoot, `.tmp-${id}`)
  const artifactDirectory = join(threadRoot, id)
  const fileName = storedFileName(sourcePath)
  const temporaryPath = join(temporaryDirectory, fileName)
  const finalPath = join(artifactDirectory, fileName)
  await mkdir(temporaryDirectory, { recursive: true })
  try {
    await copyFile(sourcePath, temporaryPath)
    await rename(temporaryDirectory, artifactDirectory)
  } catch (reason) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw reason
  }
  const createdAt = new Date().toISOString()
  return {
    artifact: {
      id,
      threadId: context.threadId,
      messageId: context.messageId,
      runId: context.runId,
      name: input.name,
      mimeType: input.mimeType,
      size: sourceInfo.size,
      kind: input.kind,
      path: finalPath,
      available: true,
      textTruncated: Boolean(input.textTruncated),
      contextPolicy: input.contextPolicy,
      createdAt
    },
    storagePath: normalizedStoragePath(root, finalPath)
  }
}

export async function archiveAgentAttachments(
  inputs: AgentAttachmentInput[],
  context: { threadId: string; runId: string; messageId: string },
  root = getAgentAttachmentsDir()
): Promise<ArchivedAgentAttachment[]> {
  if (inputs.length === 0) return []
  await mkdir(join(root, context.threadId), { recursive: true })
  const archived: ArchivedAgentAttachment[] = []
  try {
    for (const input of inputs) {
      archived.push(await archiveOne(input, context, root))
    }
    return archived
  } catch (reason) {
    await deleteArchivedAgentAttachments(
      archived.map((item) => item.artifact),
      root
    )
    throw reason
  }
}

export async function deleteArchivedAgentAttachments(
  attachments: Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>,
  root = getAgentAttachmentsDir()
): Promise<void> {
  return withApplicationDataMutation(async () => {
    const managedRoot = resolve(root)
    await Promise.all(attachments.map(async (attachment) => {
      if (!attachment.path) return
      const artifactDirectory = resolve(attachment.path, '..')
      if (
        !artifactDirectory.startsWith(`${managedRoot}${sep}`)
        || artifactDirectory.split(/[\\/]/).at(-1) !== attachment.id
      ) {
        throw new Error(`Attachment ${attachment.id} has an invalid managed path.`)
      }
      await rm(artifactDirectory, { recursive: true, force: true })
    }))
  })
}

export async function deleteArchivedAgentThreadAttachments(
  threadId: string,
  root = getAgentAttachmentsDir()
): Promise<void> {
  return withApplicationDataMutation(async () => {
    const managedRoot = resolve(root)
    const threadRoot = resolve(managedRoot, threadId)
    if (
      !threadId
      || threadRoot === managedRoot
      || !threadRoot.startsWith(`${managedRoot}${sep}`)
      || relative(managedRoot, threadRoot).split(sep).length !== 1
    ) {
      throw new Error(`Thread ${threadId} has an invalid managed attachment path.`)
    }
    await rm(threadRoot, { recursive: true, force: true })
  })
}
