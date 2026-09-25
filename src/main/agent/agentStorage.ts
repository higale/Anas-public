import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  AgentAccessMode, AgentStorageUsageSnapshot, AgentThread, AgentThreadCreate,
  AgentThreadUpdate, AgentWorkspaceState
} from '@shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import {
  getAgentCatalogFile, getAgentConversationDatabaseFile, getAgentConversationsDir, getDataDir
} from '../config/dataDir'
import { measureDirectorySize } from '../dataStorageUsage'
import { runtimeLog } from '../runtimeLogger'
import { AgentDatabase } from './agentDatabase'
import { SqliteMemoryStore } from './memoryStore'

const catalogVersion = 1
const sqliteSuffixes = ['', '-wal', '-shm', '-journal']
const nativeDependency = createRequire(import.meta.url)
const requiredCatalogColumns: Record<string, string[]> = {
  agent_conversations: ['id', 'title', 'project_id', 'model_config_id', 'model_parameter_preset_id', 'pinned', 'access_mode', 'status', 'user_turn_count', 'has_queued_inputs', 'created_at', 'updated_at'],
  agent_thread_locations: ['thread_id', 'owner_thread_id'],
  agent_run_locations: ['run_id', 'thread_id', 'owner_thread_id', 'submission_id'],
  agent_conversation_deletions: ['owner_thread_id'],
  agent_workspace_state: ['id', 'active_thread_id', 'draft_project_id', 'draft_model_config_id', 'draft_model_parameter_preset_id'],
  agent_store_items: ['namespace_path', 'key', 'value_json', 'created_at', 'updated_at'],
  agent_memory_fts: ['namespace_path', 'key', 'content', 'keywords']
}

interface ConversationRow {
  id: string
  title: string
  project_id: string
  model_config_id: string | null
  model_parameter_preset_id: string | null
  pinned: number
  access_mode: AgentAccessMode
  status: AgentThread['status']
  user_turn_count: number
  has_queued_inputs: number
  created_at: string
  updated_at: string
}

function threadFromRow(row: ConversationRow): AgentThread {
  return {
    id: row.id, title: row.title, projectId: row.project_id,
    ...(row.model_config_id ? { modelConfigId: row.model_config_id } : {}),
    ...(row.model_parameter_preset_id ? { modelParameterPresetId: row.model_parameter_preset_id } : {}),
    pinned: Boolean(row.pinned), accessMode: row.access_mode, status: row.status,
    userTurnCount: row.user_turn_count, createdAt: row.created_at, updatedAt: row.updated_at
  }
}

function validateCatalogSchema(database: Database.Database): void {
  const version = database.pragma('user_version', { simple: true }) as number
  if (version !== catalogVersion) throw new Error(`Unsupported agent catalog schema ${version}; expected ${catalogVersion}.`)
  for (const [table, required] of Object.entries(requiredCatalogColumns)) {
    const columns = new Set((database.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).map(({ name }) => name))
    if (!columns.size) throw new Error(`Agent catalog is missing table ${table}.`)
    for (const column of required) {
      if (!columns.has(column)) throw new Error(`Agent catalog is missing column ${table}.${column}.`)
    }
  }
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text.`)
}

function runStorageWorker<T>(body: string, data: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    let result: T
    const worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const Database = require(workerData.modulePath);
      ${body}
    `, { eval: true, workerData: { ...data, modulePath: nativeDependency.resolve('better-sqlite3') } })
    worker.once('message', (value: T) => { result = value })
    worker.once('error', reject)
    worker.once('exit', (code) => code === 0 ? resolvePromise(result) : reject(new Error(`Agent storage worker exited with code ${code}.`)))
  })
}

export class AgentStorage {
  private readonly conversations = new Map<string, AgentDatabase>()
  private readonly unregisteredCreations = new Set<string>()
  private preview?: AgentDatabase
  private closed = false
  private maintaining = false
  private sharedMemoryStore: SqliteMemoryStore
  private catalog: Database.Database
  readonly dataDir: string
  readonly attachmentRoot: string

  private constructor(dataDir: string, private readonly onFileChanges?: (ownerThreadId: string, runId: string) => void) {
    this.dataDir = resolve(dataDir)
    this.attachmentRoot = join(this.dataDir, 'attachments')
    mkdirSync(dirname(getAgentCatalogFile(this.dataDir)), { recursive: true })
    this.catalog = new Database(getAgentCatalogFile(this.dataDir))
    try {
      this.initializeCatalog()
      this.sharedMemoryStore = new SqliteMemoryStore(this.catalog)
    } catch (error) {
      this.catalog.close()
      throw error
    }
  }

  static open(dataDir = getDataDir(), onFileChanges?: (ownerThreadId: string, runId: string) => void): AgentStorage {
    return new AgentStorage(dataDir, onFileChanges)
  }

  get memoryStore(): SqliteMemoryStore { return this.sharedMemoryStore }

  private initializeCatalog(): void {
    this.catalog.pragma('foreign_keys = ON')
    const version = this.catalog.pragma('user_version', { simple: true }) as number
    const tables = this.catalog.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' LIMIT 1").get()
    if (tables) {
      validateCatalogSchema(this.catalog)
      this.catalog.pragma('journal_mode = WAL')
      return
    }
    if (version !== 0) throw new Error(`Unsupported agent catalog schema ${version}; expected ${catalogVersion}.`)
    this.catalog.pragma('journal_mode = WAL')
    this.catalog.transaction(() => {
      this.catalog.exec(`
        CREATE TABLE agent_conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          project_id TEXT NOT NULL,
          model_config_id TEXT,
          model_parameter_preset_id TEXT,
          pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
          access_mode TEXT NOT NULL CHECK (access_mode IN ('strict_approval', 'read_only_allowed', 'full_access')),
          status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'interrupted', 'failed')),
          user_turn_count INTEGER NOT NULL CHECK (user_turn_count >= 0),
          has_queued_inputs INTEGER NOT NULL DEFAULT 0 CHECK (has_queued_inputs IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX agent_conversations_order_idx ON agent_conversations (pinned DESC, updated_at DESC, id);
        CREATE INDEX agent_conversations_project_idx ON agent_conversations (project_id);
        CREATE TABLE agent_thread_locations (
          thread_id TEXT PRIMARY KEY,
          owner_thread_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX agent_thread_locations_owner_idx ON agent_thread_locations (owner_thread_id);
        CREATE TABLE agent_run_locations (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES agent_thread_locations(thread_id) ON DELETE CASCADE,
          owner_thread_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          submission_id TEXT UNIQUE
        );
        CREATE INDEX agent_run_locations_owner_idx ON agent_run_locations (owner_thread_id);
        CREATE TABLE agent_conversation_deletions (
          owner_thread_id TEXT PRIMARY KEY REFERENCES agent_conversations(id) ON DELETE CASCADE
        );
        CREATE TABLE agent_workspace_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          active_thread_id TEXT REFERENCES agent_conversations(id) ON DELETE SET NULL,
          draft_project_id TEXT NOT NULL,
          draft_model_config_id TEXT,
          draft_model_parameter_preset_id TEXT
        );
      `)
      this.catalog.prepare('INSERT INTO agent_workspace_state VALUES (1, NULL, ?, NULL, NULL)').run(DEFAULT_WORKSPACE_PROJECT_ID)
      new SqliteMemoryStore(this.catalog)
      this.catalog.pragma(`user_version = ${catalogVersion}`)
    })()
  }

  static validateCatalogBackup(file: string, projectIds: ReadonlySet<string>): string[] {
    if (!existsSync(file)) return []
    if (!lstatSync(file).isFile()) throw new Error('Agent catalog is not a regular file.')
    const database = new Database(file, { readonly: true, fileMustExist: true })
    try {
      validateCatalogSchema(database)
      const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Agent catalog integrity check failed.')
      if ((database.pragma('foreign_key_check') as unknown[]).length) throw new Error('Agent catalog foreign key check failed.')
      const rows = database.prepare('SELECT id, project_id FROM agent_conversations ORDER BY id').all() as Array<{ id: string; project_id: string }>
      for (const row of rows) {
        getAgentConversationDatabaseFile(row.id, dirname(dirname(file)))
        if (!projectIds.has(row.project_id)) throw new Error(`Agent conversation references missing project ${row.project_id}.`)
      }
      const invalidLocation = database.prepare(`
        SELECT run_id FROM agent_run_locations run
        JOIN agent_thread_locations thread ON thread.thread_id = run.thread_id
        WHERE run.owner_thread_id <> thread.owner_thread_id LIMIT 1
      `).get()
      if (invalidLocation) throw new Error('Agent run location crosses conversations.')
      return rows.map(({ id }) => id)
    } finally { database.close() }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('Agent storage is closed.')
    if (this.maintaining) throw new Error('Agent storage maintenance is in progress.')
  }

  listThreads(): AgentThread[] {
    this.requireOpen()
    return (this.catalog.prepare('SELECT * FROM agent_conversations ORDER BY pinned DESC, updated_at DESC, id').all() as ConversationRow[]).map(threadFromRow)
  }

  getThread(ownerThreadId: string): AgentThread | null {
    this.requireOpen()
    const row = this.catalog.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(ownerThreadId) as ConversationRow | undefined
    return row ? threadFromRow(row) : null
  }

  ownerForThread(threadId: string): string | undefined {
    this.requireOpen()
    return (this.catalog.prepare('SELECT owner_thread_id FROM agent_thread_locations WHERE thread_id = ?').get(threadId) as { owner_thread_id: string } | undefined)?.owner_thread_id
  }

  conversationForThread(threadId: string): AgentDatabase {
    const owner = this.ownerForThread(threadId)
    if (!owner) throw new Error(`Thread ${threadId} was not found.`)
    return this.openConversation(owner)
  }

  conversationForRun(runId: string): AgentDatabase | undefined {
    this.requireOpen()
    const location = this.catalog.prepare('SELECT owner_thread_id FROM agent_run_locations WHERE run_id = ?').get(runId) as { owner_thread_id: string } | undefined
    return location ? this.openConversation(location.owner_thread_id) : undefined
  }

  submissionOwner(submissionId: string): string | undefined {
    this.requireOpen()
    return (this.catalog.prepare('SELECT owner_thread_id FROM agent_run_locations WHERE submission_id = ?').get(submissionId) as { owner_thread_id: string } | undefined)?.owner_thread_id
  }

  queuedConversationIds(): string[] {
    this.requireOpen()
    return (this.catalog.prepare('SELECT id FROM agent_conversations WHERE has_queued_inputs = 1 ORDER BY updated_at, id').all() as Array<{ id: string }>).map(({ id }) => id)
  }

  openConversation(ownerThreadId: string, options: { create?: boolean; deleting?: boolean } = {}): AgentDatabase {
    this.requireOpen()
    const deleting = this.isConversationDeleting(ownerThreadId)
    if (deleting && !options.deleting) throw new Error('Conversation deletion is pending; retry deleting this conversation to finish cleanup.')
    const file = getAgentConversationDatabaseFile(ownerThreadId, this.dataDir)
    const existing = this.conversations.get(ownerThreadId)
    if (existing) return existing
    const thread = this.getThread(ownerThreadId)
    if (!thread && !options.create) throw new Error(`Conversation ${ownerThreadId} was not found.`)
    if (!thread && existsSync(file)) throw new Error(`Conversation database already exists: ${ownerThreadId}`)
    if (thread && !existsSync(file)) throw new Error(`Conversation database is missing: ${ownerThreadId}`)
    if (existsSync(file) && !lstatSync(file).isFile()) throw new Error(`Conversation database is not a regular file: ${ownerThreadId}`)
    const database = AgentDatabase.open(file, this.attachmentRoot, (runId) => this.onFileChanges?.(ownerThreadId, runId), {
      memoryStore: this.sharedMemoryStore,
      onChanged: (current) => {
        if (this.closed || this.conversations.get(ownerThreadId) !== current) return
        try { this.refreshConversation(ownerThreadId) } catch (error) {
          runtimeLog('error', 'agent-storage', 'Failed to refresh conversation directory metadata.', { ownerThreadId, error })
        }
      }
    })
    this.conversations.set(ownerThreadId, database)
    if (!thread) this.unregisteredCreations.add(ownerThreadId)
    try {
      if (thread && !deleting && !database.getThread(ownerThreadId)) throw new Error(`Conversation database does not belong to ${ownerThreadId}.`)
      this.refreshConversation(ownerThreadId)
      return database
    } catch (error) {
      this.conversations.delete(ownerThreadId)
      database.close()
      throw error
    }
  }

  createThread(options: AgentThreadCreate = {}, threadId: string = randomUUID()): AgentThread {
    this.requireOpen()
    if (this.getThread(threadId)) throw new Error(`Conversation ${threadId} already exists.`)
    const database = this.openConversation(threadId, { create: true })
    try {
      const thread = database.createThread(options, threadId)
      this.refreshConversation(threadId)
      return thread
    } catch (error) {
      this.closeConversation(threadId)
      for (const suffix of sqliteSuffixes) {
        const file = `${getAgentConversationDatabaseFile(threadId, this.dataDir)}${suffix}`
        if (existsSync(file)) unlinkSync(file)
      }
      this.unregisteredCreations.delete(threadId)
      throw error
    }
  }

  refreshConversation(ownerThreadId: string): void {
    this.requireOpen()
    const database = this.conversations.get(ownerThreadId)
    const thread = database?.getThread(ownerThreadId)
    if (!database || !thread) return
    const threadIds = database.listThreadIds()
    const runs = database.listRunLocators()
    this.catalog.transaction(() => {
      this.catalog.prepare(`
        INSERT INTO agent_conversations VALUES (@id, @title, @projectId, @modelConfigId, @modelParameterPresetId,
          @pinned, @accessMode, @status, @userTurnCount, @queued, @createdAt, @updatedAt)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, project_id=excluded.project_id,
          model_config_id=excluded.model_config_id, model_parameter_preset_id=excluded.model_parameter_preset_id,
          pinned=excluded.pinned, access_mode=excluded.access_mode, status=excluded.status,
          user_turn_count=excluded.user_turn_count, has_queued_inputs=excluded.has_queued_inputs,
          updated_at=excluded.updated_at
      `).run({ ...thread, modelConfigId: thread.modelConfigId ?? null,
        modelParameterPresetId: thread.modelParameterPresetId ?? null, pinned: Number(thread.pinned),
        queued: Number(database.hasQueuedInputs()) })
      const localThreads = new Set(threadIds)
      for (const row of this.catalog.prepare('SELECT thread_id FROM agent_thread_locations WHERE owner_thread_id = ?').all(ownerThreadId) as Array<{ thread_id: string }>) {
        if (!localThreads.has(row.thread_id)) this.catalog.prepare('DELETE FROM agent_thread_locations WHERE thread_id = ?').run(row.thread_id)
      }
      const insertThread = this.catalog.prepare('INSERT OR IGNORE INTO agent_thread_locations VALUES (?, ?)')
      for (const id of threadIds) {
        const existing = this.ownerForThread(id)
        if (existing && existing !== ownerThreadId) throw new Error(`Thread ${id} already belongs to another conversation.`)
        insertThread.run(id, ownerThreadId)
      }
      const localRuns = new Set(runs.map(({ id }) => id))
      for (const row of this.catalog.prepare('SELECT run_id FROM agent_run_locations WHERE owner_thread_id = ?').all(ownerThreadId) as Array<{ run_id: string }>) {
        if (!localRuns.has(row.run_id)) this.catalog.prepare('DELETE FROM agent_run_locations WHERE run_id = ?').run(row.run_id)
      }
      const insertRun = this.catalog.prepare(`
        INSERT INTO agent_run_locations VALUES (@id, @threadId, @ownerThreadId, @submissionId)
        ON CONFLICT(run_id) DO UPDATE SET submission_id=excluded.submission_id
        WHERE agent_run_locations.owner_thread_id = excluded.owner_thread_id
          AND agent_run_locations.thread_id = excluded.thread_id
          AND agent_run_locations.submission_id IS NOT excluded.submission_id
      `)
      const runLocation = this.catalog.prepare('SELECT owner_thread_id, thread_id FROM agent_run_locations WHERE run_id = ?')
      for (const run of runs) {
        const existing = runLocation.get(run.id) as { owner_thread_id: string; thread_id: string } | undefined
        if (existing && (existing.owner_thread_id !== ownerThreadId || existing.thread_id !== run.threadId)) {
          throw new Error(`Run ${run.id} already belongs to another conversation.`)
        }
        insertRun.run({ ...run, ownerThreadId, submissionId: run.submissionId ?? null })
      }
    })()
    this.unregisteredCreations.delete(ownerThreadId)
  }

  updateThread(threadId: string, update: AgentThreadUpdate): AgentThread {
    const database = this.conversationForThread(threadId)
    const next = database.updateThread(threadId, update)
    if (update.projectId !== undefined && this.getThread(threadId)) {
      for (const childId of database.listThreadIds()) {
        if (childId !== threadId) database.updateThread(childId, { projectId: update.projectId })
      }
    }
    this.refreshConversation(this.ownerForThread(threadId)!)
    return next
  }

  setAccessMode(threadId: string, accessMode: AgentAccessMode): AgentThread {
    const next = this.conversationForThread(threadId).setAccessMode(threadId, accessMode)
    this.refreshConversation(this.ownerForThread(threadId)!)
    return next
  }

  getWorkspaceState(): AgentWorkspaceState {
    this.requireOpen()
    const row = this.catalog.prepare('SELECT * FROM agent_workspace_state WHERE id = 1').get() as {
      active_thread_id: string | null; draft_project_id: string; draft_model_config_id: string | null; draft_model_parameter_preset_id: string | null
    } | undefined
    if (!row) throw new Error('Agent workspace state is missing.')
    return row.active_thread_id ? { mode: 'thread', threadId: row.active_thread_id } : {
      mode: 'new_thread', projectId: row.draft_project_id,
      ...(row.draft_model_config_id ? { modelConfigId: row.draft_model_config_id } : {}),
      modelParameterPresetId: row.draft_model_parameter_preset_id
    }
  }

  setWorkspaceState(state: AgentWorkspaceState): void {
    this.requireOpen()
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Agent workspace state is invalid.')
    if (state.mode === 'thread') {
      if (!this.getThread(state.threadId)) throw new Error(`Conversation ${state.threadId} was not found.`)
      this.catalog.prepare('UPDATE agent_workspace_state SET active_thread_id = ? WHERE id = 1').run(state.threadId)
      return
    }
    if (state.mode !== 'new_thread') throw new Error('Agent workspace mode is invalid.')
    requireText(state.projectId, 'Agent workspace project ID')
    if (state.modelConfigId !== undefined) requireText(state.modelConfigId, 'Agent workspace model configuration ID')
    if (state.modelParameterPresetId !== null) {
      requireText(state.modelParameterPresetId, 'Agent workspace model parameter preset ID')
      if (!state.modelConfigId) throw new Error('A model parameter preset requires a model configuration.')
    }
    this.catalog.prepare(`UPDATE agent_workspace_state SET active_thread_id = NULL, draft_project_id = ?,
      draft_model_config_id = ?, draft_model_parameter_preset_id = ? WHERE id = 1`)
      .run(state.projectId, state.modelConfigId ?? null, state.modelParameterPresetId)
  }

  previewDatabase(): AgentDatabase {
    this.requireOpen()
    return this.preview ??= AgentDatabase.open(':memory:', this.attachmentRoot, undefined, { memoryStore: this.sharedMemoryStore })
  }

  openedConversations(): Array<{ ownerId: string; database: AgentDatabase }> {
    this.requireOpen()
    return [...this.conversations].map(([ownerId, database]) => ({ ownerId, database }))
  }

  closeConversation(ownerThreadId: string): void {
    const database = this.conversations.get(ownerThreadId)
    if (!database) return
    try { this.refreshConversation(ownerThreadId) } finally {
      this.conversations.delete(ownerThreadId)
      database.close()
    }
  }

  isConversationDeleting(ownerThreadId: string): boolean {
    this.requireOpen()
    return Boolean(this.catalog.prepare('SELECT 1 FROM agent_conversation_deletions WHERE owner_thread_id = ?').get(ownerThreadId))
  }

  beginConversationDeletion(ownerThreadId: string): void {
    this.requireOpen()
    this.catalog.prepare('INSERT OR IGNORE INTO agent_conversation_deletions VALUES (?)').run(ownerThreadId)
  }

  conversationForDeletion(ownerThreadId: string): AgentDatabase | undefined {
    this.requireOpen()
    if (this.isConversationDeleting(ownerThreadId) && !existsSync(getAgentConversationDatabaseFile(ownerThreadId, this.dataDir))) {
      return undefined
    }
    return this.openConversation(ownerThreadId, { deleting: true })
  }

  async removeConversation(ownerThreadId: string): Promise<void> {
    this.requireOpen()
    const file = getAgentConversationDatabaseFile(ownerThreadId, this.dataDir)
    if (!this.getThread(ownerThreadId)) {
      if (!this.unregisteredCreations.has(ownerThreadId)) return
      const database = this.conversations.get(ownerThreadId)
      if (database?.listThreadIds().length) throw new Error('An unregistered conversation with saved threads cannot be discarded.')
    } else {
      this.beginConversationDeletion(ownerThreadId)
    }
    this.closeConversation(ownerThreadId)
    for (const suffix of sqliteSuffixes) await rm(`${file}${suffix}`, { force: true })
    this.catalog.prepare('DELETE FROM agent_conversations WHERE id = ?').run(ownerThreadId)
    this.unregisteredCreations.delete(ownerThreadId)
  }

  completeProjectDeletion(projectId: string): void {
    this.requireOpen()
    requireText(projectId, 'Project ID')
    this.catalog.transaction(() => {
      if (this.catalog.prepare('SELECT 1 FROM agent_conversations WHERE project_id = ? LIMIT 1').get(projectId)) {
        throw new Error('Cannot complete project deletion while project conversations still exist.')
      }
      this.sharedMemoryStore.deleteProjectMemories(projectId)
      this.catalog.prepare(`
        UPDATE agent_workspace_state SET draft_project_id = ?, draft_model_config_id = NULL,
          draft_model_parameter_preset_id = NULL WHERE draft_project_id = ?
      `).run(DEFAULT_WORKSPACE_PROJECT_ID, projectId)
    })()
  }

  async getStorageUsage(): Promise<AgentStorageUsageSnapshot> {
    const [conversationBytes, attachmentBytes, memoryBytes] = await Promise.all([
      measureDirectorySize(getAgentConversationsDir(this.dataDir)),
      measureDirectorySize(this.attachmentRoot),
      runStorageWorker<number>(`
        const database = new Database(workerData.file, { readonly: true, fileMustExist: true });
        try {
          const row = database.prepare(\`SELECT COALESCE(SUM(
            length(CAST(namespace_path AS BLOB)) + length(CAST(key AS BLOB))
            + length(CAST(value_json AS BLOB)) + length(CAST(created_at AS BLOB))
            + length(CAST(updated_at AS BLOB))
          ), 0) AS bytes FROM agent_store_items
          WHERE json_extract(namespace_path, '$[0]') = 'memories'\`).get();
          parentPort.postMessage(row.bytes);
        } finally { database.close(); }
      `, { file: getAgentCatalogFile(this.dataDir) })
    ])
    return {
      conversations: { totalBytes: conversationBytes + attachmentBytes, approximate: true },
      memories: { totalBytes: memoryBytes, approximate: true }
    }
  }

  async compact(): Promise<void> {
    this.requireOpen()
    const files = this.listThreads().map(({ id }) => getAgentConversationDatabaseFile(id, this.dataDir))
    files.push(getAgentCatalogFile(this.dataDir))
    for (const id of [...this.conversations.keys()]) this.closeConversation(id)
    this.preview?.close()
    this.preview = undefined
    this.maintaining = true
    this.catalog.close()
    try {
      await runStorageWorker<void>(`
          for (const file of workerData.files) {
            const database = new Database(file, { fileMustExist: true });
            try { database.exec('VACUUM'); database.pragma('wal_checkpoint(TRUNCATE)'); }
            finally { database.close(); }
          }
      `, { files })
    } finally {
      this.maintaining = false
      this.catalog = new Database(getAgentCatalogFile(this.dataDir))
      this.initializeCatalog()
      this.sharedMemoryStore = new SqliteMemoryStore(this.catalog)
    }
  }

  close(): void {
    if (this.closed) return
    if (this.maintaining) throw new Error('Wait for agent storage maintenance to finish before closing.')
    for (const id of [...this.conversations.keys()]) this.closeConversation(id)
    this.preview?.close()
    this.preview = undefined
    this.closed = true
    this.catalog.close()
  }
}
