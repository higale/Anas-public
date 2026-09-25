import { validateRestoredTools } from './toolsStore'
import { access, lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentDatabase } from './agent/agentDatabase'
import { AgentStorage } from './agent/agentStorage'
import { normalizeAppConfigSnapshot } from './config/appConfig'
import {
  configDirName, getAgentCatalogFile, getAgentConversationDatabaseFile,
  getAgentConversationsDir, skillsConfigFileName
} from './config/dataDir'
import { readRawConfigFromDirectory } from './config/rawAppConfig'
import { readInputHistoryStoreFile } from './inputHistoryStore'
import { readProjectStoreFile } from './projectStore'
import { validateRestoredSkillsDirectory, validateSkillsConfigFile } from './skillsStore'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
}

export async function validateRestoredDataDirectory(root: string): Promise<void> {
  const configRoot = join(root, configDirName)
  normalizeAppConfigSnapshot(await readRawConfigFromDirectory(configRoot))
  await validateSkillsConfigFile(join(configRoot, skillsConfigFileName))
  const projects = join(root, 'projects.json')
  const projectIds = new Set([DEFAULT_WORKSPACE_PROJECT_ID])
  if (await exists(projects)) {
    const store = await readProjectStoreFile(projects)
    for (const project of store.projects) projectIds.add(project.id)
  }
  const inputHistory = join(root, 'input_history.json')
  if (await exists(inputHistory)) await readInputHistoryStoreFile(inputHistory)
  await validateRestoredSkillsDirectory(join(root, 'skills'))
  await validateRestoredTools(root)
  const catalog = getAgentCatalogFile(root)
  const conversationIds = AgentStorage.validateCatalogBackup(catalog, projectIds)
  const conversationsDir = getAgentConversationsDir(root)
  if (await exists(conversationsDir)) {
    if (!(await lstat(conversationsDir)).isDirectory()) throw new Error('Conversation storage is not a directory.')
    const expected = new Set(conversationIds.map((id) => `${id}.sqlite`))
    for (const entry of await readdir(conversationsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !expected.has(entry.name)) {
        throw new Error(`Unexpected conversation storage entry: ${entry.name}`)
      }
    }
  }
  for (const id of conversationIds) {
    const file = getAgentConversationDatabaseFile(id, root)
    if (!(await lstat(file)).isFile()) throw new Error(`Conversation database is not a regular file: ${id}`)
    AgentDatabase.validateBackup(file, join(root, 'attachments'), projectIds, id)
  }
}
