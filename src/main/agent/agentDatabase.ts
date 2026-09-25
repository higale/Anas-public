import { validateSubagentSelection } from '@shared/subagentSelection'
import Database from 'better-sqlite3'
import { FileChangeLedger, fileChangeLedgerSchema } from './fileChangeLedger'
import { agentToolEffectArtifactId } from './toolEffectScope'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import {
  BaseMessage,
  AIMessage,
  HumanMessage,
  ToolMessage,
  mapStoredMessageToChatMessage,
  type StoredMessage
} from '@langchain/core/messages'
import { Command } from '@langchain/langgraph'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import { toAgentMessage } from './messageMapper'
import { CurrentStateSqliteSaver } from './currentStateSqliteSaver'
import { isManagedToolResultReference } from './managedToolResult'
import { readMessageBodySync, type EncodedStateValue } from './currentStateMessageCodec'
import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint'
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  isAgentThreadLocked,
  type AgentAccessMode,
  type AgentAttachmentArtifact,
  type AgentContentBlock,
  type AgentRun,
  type AgentRunActivity,
  type AgentRunStatus,
  type AgentContextSummary,
  type AgentContextStatus,
  type AgentMemoryRecall,
  type AgentModelActivity,
  type AgentQueuedInput,
  type AgentQueuedInputCreate,
  type AgentSubagentActivity,
  type AgentThread,
  type AgentThreadCreate,
  type AgentThreadUpdate,
  type AgentThreadStatus,
  type AgentToolApproval,
  type AgentToolActivity,
  type AgentToolCall
} from '@shared/agentTypes'
import { getAgentAttachmentsDir } from '../config/dataDir'
import {
  DEFAULT_WORKSPACE_PROJECT_ID,
  type SelectedAttachment,
  type SubagentConfig,
  type SubagentPreset
} from '@shared/types'
import type { ArchivedAgentAttachment } from './agentAttachmentStore'
import { AgentThreadLockedError } from './agentErrors'
import { SqliteMemoryStore } from './memoryStore'
import { validateCapabilities, parseRunConfiguration, serializeRunConfiguration, type RunConfiguration } from '@shared/agentCapabilities'
import type { CodeReviewSnapshot } from '@shared/codeReview'
import { validateCodeReviewSnapshot } from './codeReview'

const schemaVersion = 1

const modelRoundSql = `(SELECT COUNT(*) FROM agent_model_activities previous
  WHERE previous.run_id = model.run_id AND previous.subagent_id IS model.subagent_id
    AND previous.sequence <= model.sequence)`

interface SchemaColumn {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  hidden: number
}

function schemaColumns(database: Database.Database, table: string): SchemaColumn[] {
  return database.prepare('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?)').all(table) as SchemaColumn[]
}

type ThreadRow = {
  id: string
  title: string
  project_id: string
  model_config_id: string | null
  model_parameter_preset_id: string | null
  pinned: number
  full_access: number
  strict_approval: number
  status: AgentThreadStatus
  user_turn_count: number
  created_at: string
  updated_at: string
}

type RunRow = {
  id: string
  thread_id: string
  operation: AgentRun['operation']
  status: AgentRunStatus
  created_at: string
  updated_at: string
  error: string | null
}

type RunCheckpointRow = {
  id: string
  thread_id: string
  last_checkpoint_id: string | null
  terminal_checkpoint_id: string | null
  last_write_checkpoint_ns: string | null
  last_write_checkpoint_id: string | null
  cancellation_requested: number
}

export type AgentSubagentCallStatus =
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AgentSubagentCallRecord {
  id: string
  ownerThreadId: string
  parentThreadId: string
  parentRunId: string
  parentSubagentId?: string
  childThreadId: string
  childRunId: string
  agentName: string
  config: SubagentConfig
  description: string
  status: AgentSubagentCallStatus
  result?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export interface AgentSubagentCallTransition {
  call: AgentSubagentCallRecord
  activity: AgentSubagentActivity
}

type SubagentCallRow = {
  id: string
  owner_thread_id: string
  parent_thread_id: string
  parent_run_id: string
  parent_subagent_id: string | null
  child_thread_id: string
  child_run_id: string
  agent_name: string
  config_json: string
  description: string
  status: AgentSubagentCallStatus
  result_text: string | null
  error: string | null
  created_at: string
  updated_at: string
}

type ActivityRow = {
  run_id: string
  sequence: number
  kind: 'tool' | 'subagent'
  activity_id: string
  parent_subagent_id: string | null
  name: string
  status: 'running' | 'completed'
  output_json: string | null
  approval_interrupt_id: string | null
  approval_action_index: number | null
  subagent_name: string | null
  subagent_parent_id: string | null
  subagent_status: AgentSubagentCallStatus | null
  subagent_result_text: string | null
  subagent_error: string | null
  subagent_updated_at: string | null
  started_at: string
  completed_at: string | null
}

type SubagentActivityPayload = {
  status: AgentSubagentActivity['status']
  result?: unknown
  error?: string
}

function parseSubagentActivityPayload(value: string | null): SubagentActivityPayload {
  const payload = parseValue(value)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Stored subagent activity payload is invalid.')
  }
  const record = payload as Record<string, unknown>
  if (
    record.status !== 'running'
    && record.status !== 'interrupted'
    && record.status !== 'completed'
    && record.status !== 'failed'
    && record.status !== 'cancelled'
  ) {
    throw new Error('Stored subagent activity status is invalid.')
  }
  if (record.error !== undefined && typeof record.error !== 'string') {
    throw new Error('Stored subagent activity error is invalid.')
  }
  return {
    status: record.status,
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error })
  }
}

const subagentConfigNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const subagentConfigPresets = new Set<SubagentPreset>([
  'general-purpose',
  'web-researcher',
  'project-analyst'
])

function normalizeSubagentConfigSnapshot(value: unknown): SubagentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored subagent config snapshot is invalid.')
  }
  const raw = value as Record<string, unknown>
  if (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0) {
    throw new Error('Stored subagent config index is invalid.')
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!subagentConfigNamePattern.test(name) || name.length > 64) {
    throw new Error('Stored subagent config name is invalid.')
  }
  if (typeof raw.enabled !== 'boolean' || typeof raw.builtIn !== 'boolean') {
    throw new Error('Stored subagent config flags are invalid.')
  }
  const preset = raw.preset === undefined
    ? undefined
    : typeof raw.preset === 'string' && subagentConfigPresets.has(raw.preset as SubagentPreset)
      ? raw.preset as SubagentPreset
      : null
  if (preset === null || raw.builtIn !== (preset !== undefined)) {
    throw new Error('Stored subagent config preset is invalid.')
  }
  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined
  const systemPrompt = typeof raw.systemPrompt === 'string' ? raw.systemPrompt.trim() : undefined
  if (description === undefined || systemPrompt === undefined) {
    throw new Error('Stored subagent config text is invalid.')
  }
  if (!description || !systemPrompt) {
    throw new Error('Stored subagent config text must not be empty.')
  }
  return {
    index: raw.index as number,
    name,
    enabled: raw.enabled,
    ...(raw.subagentSelection === undefined ? {} : { subagentSelection: validateSubagentSelection(raw.subagentSelection) }),
    ...(preset === undefined ? {} : { preset }),
    builtIn: raw.builtIn,
    description,
    systemPrompt,
    capabilities: validateCapabilities(raw.capabilities)
  }
}

type ModelActivityRow = {
  run_id: string
  model_id: string
  message_id: string | null
  sequence: number
  model_round: number
  subagent_id: string | null
  status: 'running' | 'completed'
  started_at: string
  completed_at: string | null
}

type ActivityRunRow = {
  run_id: string
  run_operation: AgentRun['operation']
  run_status: AgentRunStatus
  run_error: string | null
  run_created_at: string
  run_updated_at: string
}

type ContextSummaryRow = {
  run_id: string
  summary_id: string
  sequence: number
  status: 'running' | 'completed'
  summary_text: string
  model_content: string
  committed_checkpoint_id: string | null
  cutoff_index: number | null
  activated_after_message_index: number | null
  covered_through_message_id: string | null
  first_preserved_message_id: string | null
  input_tokens_before: number | null
  input_tokens_after: number | null
  created_at: string
}

type MemoryRecallRow = {
  run_id: string
  recall_id: string
  sequence: number
  query: string
  prompt_text: string
  memory_count: number
  agent_name: string | null
  created_at: string
}

type AttachmentRow = {
  id: string
  thread_id: string
  message_id: string
  run_id: string
  name: string
  mime_type: string
  size: number
  kind: AgentAttachmentArtifact['kind']
  storage_path: string
  text_truncated: number
  context_policy: AgentAttachmentArtifact['contextPolicy']
  created_at: string
}

type QueuedInputRow = {
  id: string
  thread_id: string
  text: string
  display_text: string
  status: AgentQueuedInput['status']
  error: string | null
  created_at: string
}

type QueuedAttachmentRow = {
  id: string
  queued_input_id: string
  name: string
  mime_type: string
  size: number
  kind: SelectedAttachment['kind']
  storage_path: string
  text_truncated: number
  context_policy: SelectedAttachment['contextPolicy']
  created_at: string
}

export type AgentManagedCallKind = 'shell' | 'http' | 'builtin' | 'mcp' | 'custom'
export type AgentManagedCallStatus =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uncertain'

export interface AgentManagedCallRecord {
  id: string
  threadId: string
  runId: string
  kind: AgentManagedCallKind
  summary: string
  status: AgentManagedCallStatus
  result?: string
  outcome?: Record<string, unknown>
  error?: string
  outputChars: number
  progressCurrent?: number
  progressTotal?: number
  progressUnit?: string
  dispatchedAt?: string
  detachedAt?: string
  createdAt: string
  updatedAt: string
}

export interface AgentManagedCallOutputChunk {
  sequence: number
  stream: 'stdout' | 'stderr' | 'progress'
  startOffset: number
  endOffset: number
  text: string
}

type ManagedCallRow = {
  id: string
  thread_id: string
  run_id: string
  kind: AgentManagedCallKind
  summary: string
  status: AgentManagedCallStatus
  result_text: string | null
  outcome_json: string | null
  error: string | null
  output_chars: number
  progress_current: number | null
  progress_total: number | null
  progress_unit: string | null
  dispatched_at: string | null
  detached_at: string | null
  created_at: string
  updated_at: string
}

type ManagedCallOutputRow = {
  sequence: number
  stream: AgentManagedCallOutputChunk['stream']
  start_offset: number
  end_offset: number
  text: string
}

type ManagedCallOutputStateRow = {
  status: AgentManagedCallStatus
  output_chars: number
  next_output_sequence: number
}

type SqliteForeignKeyRow = {
  id: number
  seq: number
  table: string
  from: string
  to: string
  on_delete: string
}

function hasTables(database: Database.Database, names: readonly string[]): boolean {
  if (names.length === 0) return true
  const placeholders = names.map(() => '?').join(', ')
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name IN (${placeholders})
  `).all(...names) as Array<{ name: string }>
  return new Set(rows.map((row) => row.name)).size === names.length
}

function hasCascadeForeignKey(
  database: Database.Database,
  sourceTable: string,
  targetTable: string,
  columns: ReadonlyArray<readonly [source: string, target: string]>
): boolean {
  const foreignKeys = database.pragma(
    `foreign_key_list(${sourceTable})`
  ) as SqliteForeignKeyRow[]
  const constraints = new Map<number, SqliteForeignKeyRow[]>()
  for (const row of foreignKeys) {
    const constraint = constraints.get(row.id) ?? []
    constraint.push(row)
    constraints.set(row.id, constraint)
  }
  return [...constraints.values()].some((constraint) => {
    const ordered = [...constraint].sort((left, right) => left.seq - right.seq)
    return ordered.length === columns.length
      && ordered.every((row, index) => (
        row.table === targetTable
        && row.on_delete === 'CASCADE'
        && row.from === columns[index]?.[0]
        && row.to === columns[index]?.[1]
      ))
  })
}

function assertCascadeForeignKey(
  database: Database.Database,
  sourceTable: string,
  targetTable: string,
  columns: ReadonlyArray<readonly [source: string, target: string]>
): void {
  if (hasCascadeForeignKey(database, sourceTable, targetTable, columns)) return
  const source = columns.map(([column]) => column)
  const target = columns.map(([, column]) => column)
  const sourceDescription = source.length === 1
    ? `${sourceTable}.${source[0]}`
    : `${sourceTable} (${source.join(', ')})`
  const targetDescription = target.length === 1
    ? `${targetTable}.${target[0]}`
    : `${targetTable} (${target.join(', ')})`
  throw new Error(
    `Unsupported agent database schema: ${sourceDescription} must reference ${targetDescription} ON DELETE CASCADE.`
  )
}

function assertManagedCallStorageIntegrity(database: Database.Database): void {
  if (!hasCascadeForeignKey(database, 'agent_managed_calls', 'agent_runs', [
    ['run_id', 'id'],
    ['thread_id', 'thread_id']
  ])) {
    throw new Error(
      'Unsupported agent database schema: agent_managed_calls must reference agent_runs with (run_id, thread_id) ON DELETE CASCADE.'
    )
  }

  const invalidCall = database.prepare(`
    SELECT call.id
    FROM agent_managed_calls AS call
    LEFT JOIN agent_runs AS run ON run.id = call.run_id
    WHERE call.thread_id IS NULL
      OR run.id IS NULL
      OR run.thread_id <> call.thread_id
    LIMIT 1
  `).get() as { id: string } | undefined
  if (invalidCall) {
    throw new Error(
      `Managed call ${invalidCall.id} does not belong to its recorded conversation.`
    )
  }
}

function assertSubagentStorageIntegrity(database: Database.Database): void {
  assertCascadeForeignKey(
    database,
    'agent_hidden_threads',
    'agent_threads',
    [['thread_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_threads',
    [['owner_thread_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_threads',
    [['parent_thread_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_runs',
    [['parent_run_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_threads',
    [['child_thread_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_runs',
    [['child_run_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_runs',
    [
      ['parent_run_id', 'id'],
      ['parent_thread_id', 'thread_id']
    ]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_subagent_calls',
    [['parent_subagent_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_observations',
    'agent_subagent_calls',
    [['subagent_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_observations',
    'agent_runs',
    [['observing_run_id', 'id']]
  )

  const invalidCall = database.prepare(`
    SELECT call.id
    FROM agent_subagent_calls AS call
    LEFT JOIN agent_threads AS owner ON owner.id = call.owner_thread_id
    LEFT JOIN agent_hidden_threads AS owner_hidden ON owner_hidden.thread_id = call.owner_thread_id
    LEFT JOIN agent_threads AS parent_thread ON parent_thread.id = call.parent_thread_id
    LEFT JOIN agent_runs AS parent_run ON parent_run.id = call.parent_run_id
    LEFT JOIN agent_threads AS child_thread ON child_thread.id = call.child_thread_id
    LEFT JOIN agent_hidden_threads AS child_hidden ON child_hidden.thread_id = call.child_thread_id
    LEFT JOIN agent_runs AS child_run ON child_run.id = call.child_run_id
    LEFT JOIN agent_subagent_calls AS parent_call ON parent_call.id = call.parent_subagent_id
    WHERE owner.id IS NULL
      OR owner_hidden.thread_id IS NOT NULL
      OR parent_thread.id IS NULL
      OR parent_run.id IS NULL
      OR parent_run.thread_id <> call.parent_thread_id
      OR child_thread.id IS NULL
      OR child_hidden.thread_id IS NULL
      OR child_run.id IS NULL
      OR child_run.thread_id <> call.child_thread_id
      OR child_thread.project_id <> owner.project_id
      OR parent_thread.project_id <> owner.project_id
      OR (
        call.parent_subagent_id IS NULL
        AND call.parent_thread_id <> call.owner_thread_id
      )
      OR (
        call.parent_subagent_id IS NOT NULL
        AND (
          parent_call.id IS NULL
          OR parent_call.id = call.id
          OR parent_call.owner_thread_id <> call.owner_thread_id
          OR parent_call.child_thread_id <> call.parent_thread_id
          OR parent_call.child_run_id <> call.parent_run_id
        )
      )
    LIMIT 1
  `).get() as { id: string } | undefined
  if (invalidCall) {
    throw new Error(`Subagent ${invalidCall.id} has an invalid conversation relationship.`)
  }

  const invalidObservation = database.prepare(`
    SELECT observation.subagent_id, observation.observing_run_id
    FROM agent_subagent_observations AS observation
    LEFT JOIN agent_subagent_calls AS call ON call.id = observation.subagent_id
    LEFT JOIN agent_runs AS observing_run ON observing_run.id = observation.observing_run_id
    WHERE call.id IS NULL
      OR observing_run.id IS NULL
      OR observation.observing_run_id <> call.parent_run_id
      OR observing_run.thread_id <> call.parent_thread_id
    LIMIT 1
  `).get() as { subagent_id: string; observing_run_id: string } | undefined
  if (invalidObservation) {
    throw new Error(
      `Subagent observation ${invalidObservation.subagent_id}/${invalidObservation.observing_run_id} does not belong to its parent run.`
    )
  }

  const storedConfigs = database.prepare(`
    SELECT id, agent_name, config_json
    FROM agent_subagent_calls
    ORDER BY rowid ASC
  `).all() as Array<{ id: string; agent_name: string; config_json: string }>
  for (const stored of storedConfigs) {
    const config = normalizeSubagentConfigSnapshot(parseValue(stored.config_json))
    if (config.name !== stored.agent_name) {
      throw new Error(`Subagent ${stored.id} config snapshot does not match its stored name.`)
    }
  }

  const cycle = database.prepare(`
    WITH RECURSIVE ancestry(origin_id, current_id, parent_id, path, cyclic) AS (
      SELECT id, id, parent_subagent_id, ',' || id || ',', 0
      FROM agent_subagent_calls
      UNION ALL
      SELECT
        ancestry.origin_id,
        parent.id,
        parent.parent_subagent_id,
        ancestry.path || parent.id || ',',
        instr(ancestry.path, ',' || parent.id || ',') > 0
      FROM ancestry
      INNER JOIN agent_subagent_calls AS parent ON parent.id = ancestry.parent_id
      WHERE ancestry.parent_id IS NOT NULL AND ancestry.cyclic = 0
    )
    SELECT origin_id
    FROM ancestry
    WHERE cyclic = 1
    LIMIT 1
  `).get() as { origin_id: string } | undefined
  if (cycle) throw new Error(`Subagent ancestry contains a cycle at ${cycle.origin_id}.`)

  const invalidProjection = database.prepare(`
    WITH RECURSIVE projected(run_id, subagent_id) AS (
      SELECT parent_run_id, id
      FROM agent_subagent_calls
      UNION ALL
      SELECT projected.run_id, child.id
      FROM projected
      INNER JOIN agent_subagent_calls AS child
        ON child.parent_subagent_id = projected.subagent_id
    ), projected_once AS (
      SELECT DISTINCT run_id, subagent_id
      FROM projected
    ), referenced AS (
      SELECT
        activity.run_id,
        activity.activity_key AS reference_key,
        CASE
          WHEN activity.kind = 'subagent' THEN activity.activity_id
          ELSE activity.parent_subagent_id
        END AS subagent_id
      FROM agent_activities AS activity
      WHERE activity.kind = 'subagent' OR activity.parent_subagent_id IS NOT NULL
      UNION ALL
      SELECT
        model.run_id,
        'model:' || model.model_id,
        model.subagent_id
      FROM agent_model_activities AS model
      WHERE model.subagent_id IS NOT NULL
    )
    SELECT referenced.reference_key
    FROM referenced
    LEFT JOIN projected_once
      ON projected_once.run_id = referenced.run_id
      AND projected_once.subagent_id = referenced.subagent_id
    WHERE projected_once.subagent_id IS NULL
    LIMIT 1
  `).get() as { reference_key: string } | undefined
  if (invalidProjection) {
    throw new Error(
      `Subagent activity ${invalidProjection.reference_key} does not belong to its projected run.`
    )
  }

  const invalidSubagentActivity = database.prepare(`
    SELECT activity.activity_key
    FROM agent_activities AS activity
    INNER JOIN agent_subagent_calls AS call ON call.id = activity.activity_id
    WHERE activity.kind = 'subagent'
      AND activity.parent_subagent_id IS NOT call.parent_subagent_id
    LIMIT 1
  `).get() as { activity_key: string } | undefined
  if (invalidSubagentActivity) {
    throw new Error(
      `Subagent activity ${invalidSubagentActivity.activity_key} has an invalid parent.`
    )
  }
}

function assertAttachmentCleanupOutboxIntegrity(database: Database.Database): void {
  const liveThreadCleanup = database.prepare(`
    SELECT cleanup.thread_id
    FROM agent_attachment_cleanup_outbox AS cleanup
    INNER JOIN agent_threads AS thread ON thread.id = cleanup.thread_id
    LIMIT 1
  `).get() as { thread_id: string } | undefined
  if (liveThreadCleanup) {
    throw new Error(
      `Live conversation ${liveThreadCleanup.thread_id} cannot be scheduled for attachment cleanup.`
    )
  }
}

function assertCleanupStorageIntegrity(database: Database.Database): void {
  assertAttachmentCleanupOutboxIntegrity(database)
  const files = database.prepare('SELECT attachment_id, thread_id, storage_path FROM agent_attachment_file_cleanup_outbox').all() as Array<{
    attachment_id: string; thread_id: string; storage_path: string
  }>
  for (const file of files) {
    const segments = file.storage_path.split('/')
    if (segments.length !== 3 || segments[0] !== file.thread_id || segments[1] !== file.attachment_id
      || segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\:]/.test(segment))) {
      throw new Error(`Attachment cleanup ${file.attachment_id} has an invalid managed path.`)
    }
    const referenced = database.prepare(`SELECT 1 FROM agent_attachments WHERE id = ? OR storage_path = ?
      UNION ALL SELECT 1 FROM agent_queued_attachments WHERE id = ? OR storage_path = ? LIMIT 1`)
      .get(file.attachment_id, file.storage_path, file.attachment_id, file.storage_path)
    if (referenced) throw new Error(`Live attachment ${file.attachment_id} cannot be scheduled for cleanup.`)
  }
}

const terminalManagedCallStatuses = new Set<AgentManagedCallStatus>([
  'completed',
  'failed',
  'cancelled',
  'uncertain'
])

function isTerminalManagedCallStatus(status: AgentManagedCallStatus): boolean {
  return terminalManagedCallStatuses.has(status)
}

type ToolEffectJournalRow = {
  run_id: string
  thread_id: string
  checkpoint_id: string
  checkpoint_ns: string
  write_checkpoint_ns: string
  task_id: string
  call_key: string
  input_hash: string
  call_index: number
  tool_call_id: string | null
  tool_name: string
  args_json: string
  recovery_mode: AgentToolEffectRecoveryMode
  state: AgentToolEffectState
  effect_attempt: number
  confirmation_count: number
  automatic_retry_count: number
  effect_kind: string | null
  target_json: string | null
  idempotency_fingerprint: string | null
  result_type: string | null
  result_blob: Uint8Array | null
}

interface SerializedToolEffectCommand {
  anasToolEffectResult: 'command'
  command: {
    graph?: string
    update?: unknown
    resume?: unknown
    goto?: unknown
  }
}

export interface StoredContextSummary extends AgentContextSummary {
  runId: string
  modelContent: string
  committedCheckpointId: string
  cutoffIndex: number
  activatedAfterMessageIndex: number
}

export interface StagedContextSummaryDetails {
  summaryText: string
  modelContent?: string
  cutoffIndex?: number
  activatedAfterMessageIndex?: number
  coveredThroughMessageId?: string
  firstPreservedMessageId?: string
  inputTokensBefore?: number
  inputTokensAfter?: number
}

export interface ContextSummaryCheckpointMatch {
  summaryId: string
  modelContent: string
  cutoffIndex: number
  runId?: string
}

export type ContextSummaryReconcileScope =
  | { type: 'preserve_staged' }
  | { type: 'run'; runId: string }

export interface DurableRootModelActivity {
  messageId: string
  text: string
  reasoning: string
  toolCalls: AgentToolCall[]
}

export interface DurableRootToolActivity {
  call: AgentToolCall
  output: unknown
  subagentName?: string
  subagentId?: string
}

export interface DurableRootActivityEvidence {
  models: DurableRootModelActivity[]
  tools: DurableRootToolActivity[]
}

export interface AgentRunCheckpointState {
  runId: string
  lastCommittedCheckpointId?: string
  terminalCheckpointId?: string
  lastWriteCheckpointNamespace?: string
  lastWriteCheckpointId?: string
  resumeIntent?: AgentRunResumeIntent
  cancellationRequested: boolean
}

export type AgentRunInputIntent =
  | {
      kind: 'user'
      text: string
      codeReview?: CodeReviewSnapshot
      displayText?: string
      content?: AgentContentBlock[]
  }
  | { kind: 'manual_compression' }
  | { kind: 'regeneration'; message: StoredMessage }

export type AgentRunningRunDurability =
  | 'terminal'
  | 'cancellation'
  | 'error'
  | 'recoverable'
  | 'no_progress'

export type AgentRunResumeIntent = Record<string, unknown>

export interface AgentRunResumeEntry {
  interruptId: string
  response: unknown
}

export type AgentToolEffectRecoveryMode = 'confirm' | 'idempotent'

export type AgentToolEffectState = 'prepared' | 'intent' | 'result'

export interface AgentToolEffectKey {
  runId: string
  checkpointId: string
  checkpointNs: string
  taskId: string
  callKey: string
  inputHash: string
}

export interface AgentToolEffectPreparation extends AgentToolEffectKey {
  threadId: string
  writeCheckpointNs: string
  callIndex: number
  toolCallId?: string
  toolName: string
  argsJson: string
  recoveryMode: AgentToolEffectRecoveryMode
}

export interface AgentToolEffectArmDetails {
  effectKind: string
  targetJson: string
  recoveryMode?: AgentToolEffectRecoveryMode
  idempotencyFingerprint?: string
}

export type AgentToolEffectRetry =
  | {
      kind: 'approved'
      expectedConfirmationCount: number
    }
  | {
      kind: 'automatic'
      expectedAutomaticRetryCount: number
    }

export interface AgentToolEffectSerializedResult {
  resultType: string
  resultBlob: Uint8Array
}

export interface AgentToolEffectRejectedConfirmation {
  kind: 'rejected'
  expectedConfirmationCount: number
}

export interface AgentToolEffectResultInput {
  result: AgentToolEffectResult
  confirmation?: AgentToolEffectRejectedConfirmation
}

export interface AgentToolEffectRow extends AgentToolEffectKey {
  threadId: string
  writeCheckpointNs: string
  callIndex: number
  toolCallId?: string
  toolName: string
  argsJson: string
  recoveryMode: AgentToolEffectRecoveryMode
  state: AgentToolEffectState
  effectAttempt: number
  confirmationCount: number
  automaticRetryCount: number
  effectKind?: string
  targetJson?: string
  idempotencyFingerprint?: string
  resultType?: string
  resultBlob?: Uint8Array
}

export type AgentToolEffectResult = ToolMessage | Command

function serializeRunInputIntent(intent: AgentRunInputIntent): string {
  const serialized = JSON.stringify(intent)
  if (serialized === undefined) {
    throw new Error('A run input intent must be JSON-serializable.')
  }
  JSON.parse(serialized)
  return serialized
}

function parseRunInputIntent(serialized: string): AgentRunInputIntent {
  const value = JSON.parse(serialized) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('kind' in value)) {
    throw new Error('A durable run input intent is invalid.')
  }
  const intent = value as Record<string, unknown>
  if (intent.kind === 'manual_compression') {
    return { kind: intent.kind }
  }
  if (intent.kind === 'regeneration') {
    if (!intent.message || typeof intent.message !== 'object' || Array.isArray(intent.message)) {
      throw new Error('A durable regeneration input is invalid.')
    }
    let message
    try {
      message = mapStoredMessageToChatMessage(intent.message as StoredMessage)
    } catch {
      throw new Error('A durable regeneration input is invalid.')
    }
    if (!HumanMessage.isInstance(message)) {
      throw new Error('A durable regeneration input must contain a user message.')
    }
    return { kind: 'regeneration', message: message.toDict() }
  }
  if (
    intent.kind !== 'user'
    || typeof intent.text !== 'string'
    || (intent.displayText !== undefined && typeof intent.displayText !== 'string')
    || (intent.content !== undefined && !Array.isArray(intent.content))
  ) {
    throw new Error('A durable user run input intent is invalid.')
  }
  return {
    kind: 'user',
    text: intent.text,
    ...(intent.codeReview === undefined ? {} : { codeReview: validateCodeReviewSnapshot(intent.codeReview) }),
    ...(intent.displayText === undefined ? {} : { displayText: intent.displayText }),
    ...(intent.content === undefined
      ? {}
      : { content: intent.content as AgentContentBlock[] })
  }
}

function serializeResumeResponse(response: unknown): string {
  const serialized = JSON.stringify(response)
  if (serialized === undefined) {
    throw new Error('A run resume response must be JSON-serializable.')
  }
  JSON.parse(serialized)
  return serialized
}

function timestamp(): string {
  return new Date().toISOString()
}

function defaultTitle(title?: string): string {
  const normalized = title?.replace(/\s+/g, ' ').trim()
  return normalized || 'New Thread'
}

function accessModeColumns(accessMode: AgentAccessMode): {
  fullAccess: number
  strictApproval: number
} {
  if (
    accessMode !== 'read_only_allowed'
    && accessMode !== 'strict_approval'
    && accessMode !== 'full_access'
  ) throw new Error('Agent access mode is invalid.')
  return {
    fullAccess: accessMode === 'full_access' ? 1 : 0,
    strictApproval: accessMode === 'strict_approval' ? 1 : 0
  }
}

function threadFromRow(row: ThreadRow): AgentThread {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    modelConfigId: row.model_config_id ?? undefined,
    modelParameterPresetId: row.model_parameter_preset_id ?? undefined,
    pinned: row.pinned === 1,
    accessMode: row.full_access === 1
      ? 'full_access'
      : row.strict_approval === 1
        ? 'strict_approval'
        : 'read_only_allowed',
    status: row.status,
    userTurnCount: row.user_turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function runFromRow(row: RunRow, backgroundCleanup?: AgentRun['backgroundCleanup']): AgentRun {
  return {
    id: row.id,
    threadId: row.thread_id,
    operation: row.operation,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error ?? undefined,
    ...(backgroundCleanup ? { backgroundCleanup } : {})
  }
}

function contextSummaryFromRow(row: ContextSummaryRow): AgentContextSummary {
  return {
    id: row.summary_id,
    sequence: row.sequence,
    status: row.status,
    summaryText: row.summary_text,
    activatedAfterMessageIndex: row.activated_after_message_index ?? undefined,
    coveredThroughMessageId: row.covered_through_message_id ?? undefined,
    firstPreservedMessageId: row.first_preserved_message_id ?? undefined,
    inputTokensBefore: row.input_tokens_before ?? undefined,
    inputTokensAfter: row.input_tokens_after ?? undefined,
    createdAt: row.created_at
  }
}

function memoryRecallFromRow(row: MemoryRecallRow): AgentMemoryRecall {
  return {
    id: row.recall_id,
    sequence: row.sequence,
    query: row.query,
    promptText: row.prompt_text,
    memoryCount: row.memory_count,
    agentName: row.agent_name ?? undefined,
    createdAt: row.created_at
  }
}

function managedCallFromRow(row: ManagedCallRow): AgentManagedCallRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    ...(row.result_text === null ? {} : { result: row.result_text }),
    ...(row.outcome_json === null
      ? {}
      : { outcome: parseValue(row.outcome_json) as Record<string, unknown> }),
    ...(row.error === null ? {} : { error: row.error }),
    outputChars: row.output_chars,
    ...(row.progress_current === null ? {} : { progressCurrent: row.progress_current }),
    ...(row.progress_total === null ? {} : { progressTotal: row.progress_total }),
    ...(row.progress_unit === null ? {} : { progressUnit: row.progress_unit }),
    ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
    ...(row.detached_at === null ? {} : { detachedAt: row.detached_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function subagentCallFromRow(row: SubagentCallRow): AgentSubagentCallRecord {
  const config = normalizeSubagentConfigSnapshot(parseValue(row.config_json))
  if (config.name !== row.agent_name) {
    throw new Error(`Subagent ${row.id} config snapshot does not match its stored name.`)
  }
  return {
    id: row.id,
    ownerThreadId: row.owner_thread_id,
    parentThreadId: row.parent_thread_id,
    parentRunId: row.parent_run_id,
    ...(row.parent_subagent_id === null ? {} : { parentSubagentId: row.parent_subagent_id }),
    childThreadId: row.child_thread_id,
    childRunId: row.child_run_id,
    agentName: row.agent_name,
    config,
    description: row.description,
    status: row.status,
    ...(row.result_text === null ? {} : { result: row.result_text }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function serializeValue(value: unknown): string | null {
  if (value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify(String(value))
  }
}

function parseValue(value: string | null): unknown {
  if (value === null) return undefined
  return JSON.parse(value) as unknown
}

function requireNonEmptyText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`)
  }
}

function validateToolEffectKey(key: AgentToolEffectKey): void {
  requireNonEmptyText(key.runId, 'Tool effect run ID')
  requireNonEmptyText(key.checkpointId, 'Tool effect checkpoint ID')
  if (typeof key.checkpointNs !== 'string') {
    throw new Error('Tool effect checkpoint namespace must be a string.')
  }
  requireNonEmptyText(key.taskId, 'Tool effect task ID')
  requireNonEmptyText(key.callKey, 'Tool effect call key')
  requireNonEmptyText(key.inputHash, 'Tool effect input hash')
}

function validateNormalizedJson(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${label} must be a JSON string.`)
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    throw new Error(`${label} must contain valid JSON.`)
  }
  if (JSON.stringify(parsed) !== value) {
    throw new Error(`${label} must contain normalized JSON.`)
  }
}

function validateRecoveryMode(value: unknown): asserts value is AgentToolEffectRecoveryMode {
  if (value !== 'confirm' && value !== 'idempotent') {
    throw new Error('Tool effect recovery mode must be confirm or idempotent.')
  }
}

function validateNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
}

function validateSerializedToolEffectResult(
  result: AgentToolEffectSerializedResult
): void {
  requireNonEmptyText(result.resultType, 'Tool effect result type')
  if (!(result.resultBlob instanceof Uint8Array)) {
    throw new Error('Tool effect result blob must be a Uint8Array.')
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function toolEffectFromRow(row: ToolEffectJournalRow): AgentToolEffectRow {
  return {
    runId: row.run_id,
    threadId: row.thread_id,
    checkpointId: row.checkpoint_id,
    checkpointNs: row.checkpoint_ns,
    writeCheckpointNs: row.write_checkpoint_ns,
    taskId: row.task_id,
    callKey: row.call_key,
    inputHash: row.input_hash,
    callIndex: row.call_index,
    toolCallId: row.tool_call_id ?? undefined,
    toolName: row.tool_name,
    argsJson: row.args_json,
    recoveryMode: row.recovery_mode,
    state: row.state,
    effectAttempt: row.effect_attempt,
    confirmationCount: row.confirmation_count,
    automaticRetryCount: row.automatic_retry_count,
    effectKind: row.effect_kind ?? undefined,
    targetJson: row.target_json ?? undefined,
    idempotencyFingerprint: row.idempotency_fingerprint ?? undefined,
    resultType: row.result_type ?? undefined,
    resultBlob: row.result_blob === null ? undefined : new Uint8Array(row.result_blob)
  }
}

function isToolEffectResult(value: unknown): value is AgentToolEffectResult {
  return ToolMessage.isInstance(value) || value instanceof Command
}

function isSerializedToolEffectCommand(value: unknown): value is SerializedToolEffectCommand {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).anasToolEffectResult === 'command'
    && (value as Record<string, unknown>).command
    && typeof (value as Record<string, unknown>).command === 'object'
    && !Array.isArray((value as Record<string, unknown>).command)
  )
}

function toolActivityKey(callId: string, subagentId?: string): string {
  return `tool:${subagentId ?? 'root'}:${callId}`
}

export class AgentDatabase {
  private static requiredTableColumns: Map<string, SchemaColumn[]> | undefined
  readonly checkpointer: CurrentStateSqliteSaver
  readonly memoryStore: SqliteMemoryStore
  readonly fileChanges: FileChangeLedger
  private readonly ownMemoryDatabase?: Database.Database
  private changeNotificationQueued = false
  private closed = false
  private readonly transientModels = new Map<string, Omit<AgentModelActivity,'sequence'|'startedAt'|'completedAt'>>()
  private readonly transientTools = new Map<string, {call:AgentToolCall;output?:unknown}>()

  private constructor(
    private readonly database: Database.Database,
    readonly attachmentRoot: string,
    onFileChanges?: (runId: string) => void,
    private readonly options: {
      memoryStore?: SqliteMemoryStore
      onChanged?: (database: AgentDatabase) => void
    } = {}
  ) {
    this.database.pragma('journal_mode = WAL')
    this.database.pragma('foreign_keys = ON')
    this.initializeSchema()
    this.database.exec(fileChangeLedgerSchema)
    this.fileChanges = new FileChangeLedger(database, onFileChanges)
    if (options.memoryStore) {
      this.memoryStore = options.memoryStore
    } else {
      this.ownMemoryDatabase = new Database(':memory:')
      this.memoryStore = new SqliteMemoryStore(this.ownMemoryDatabase)
    }
    this.checkpointer = new CurrentStateSqliteSaver(database, {
      onCheckpoint: (config, checkpoint, metadata) => this.commitCurrentState(config, checkpoint, metadata),
      onWrites: (config, writes, taskId) => this.commitCurrentWrites(config, writes, taskId)
    })
    this.checkpointer.initialize()
    this.initializeCheckpointTracking()
    this.recoverAbandonedRuns()
  }

  static open(
    file = ':memory:',
    attachmentRoot = getAgentAttachmentsDir(),
    onFileChanges?: (runId: string) => void,
    options?: { memoryStore?: SqliteMemoryStore; onChanged?: (database: AgentDatabase) => void }
  ): AgentDatabase {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
    const database = new Database(file)
    try {
      return new AgentDatabase(database, resolve(attachmentRoot), onFileChanges, options)
    } catch (error) {
      database.close()
      throw error
    }
  }

  static validateBackup(
    file: string,
    attachmentRoot: string,
    projectIds: ReadonlySet<string>,
    expectedOwnerThreadId?: string
  ): void {
    if (!existsSync(file)) return
    const database = new Database(file, { readonly: true, fileMustExist: true })
    try {
      const version = database.pragma('user_version', { simple: true }) as number
      if (version !== schemaVersion) {
        throw new Error(`Unsupported agent database schema ${version}; expected ${schemaVersion}.`)
      }
      this.validateRequiredTableColumns(database)
      const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error('Agent database integrity check failed.')
      }
      const managedTables = new Set((database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table'
          AND name IN ('agent_managed_calls', 'agent_managed_call_observations')
      `).all() as Array<{ name: string }>).map((row) => row.name))
      if (managedTables.has('agent_managed_calls')) {
        assertManagedCallStorageIntegrity(database)
      }
      assertSubagentStorageIntegrity(database)
      assertCleanupStorageIntegrity(database)
      if (managedTables.has('agent_managed_call_observations')) {
        if (!managedTables.has('agent_managed_calls')) {
          throw new Error('Managed call observations exist without the managed call table.')
        }
        const invalidObservation = database.prepare(`
          SELECT observation.call_id, observation.run_id
          FROM agent_managed_call_observations AS observation
          LEFT JOIN agent_managed_calls AS call ON call.id = observation.call_id
          LEFT JOIN agent_runs AS observing_run ON observing_run.id = observation.run_id
          WHERE call.id IS NULL
            OR observing_run.id IS NULL
            OR call.thread_id <> observing_run.thread_id
            OR observation.thread_id IS NULL
            OR observation.thread_id <> call.thread_id
            OR observation.thread_id <> observing_run.thread_id
          LIMIT 1
        `).get() as { call_id: string; run_id: string } | undefined
        if (invalidObservation) {
          throw new Error(
            `Managed call observation ${invalidObservation.call_id}/${invalidObservation.run_id} crosses conversations.`
          )
        }
      }
      const foreignKeys = database.pragma('foreign_key_check') as unknown[]
      if (foreignKeys.length > 0) throw new Error('Agent database foreign key check failed.')
      new FileChangeLedger(database).validateIntegrity()
      const threadProjects = database.prepare('SELECT DISTINCT project_id FROM agent_threads').all() as Array<{
        project_id: string
      }>
      const missingProject = threadProjects.find((row) => !projectIds.has(row.project_id))
      if (missingProject) {
        throw new Error(`Agent thread references missing project ${missingProject.project_id}.`)
      }
      if (expectedOwnerThreadId !== undefined) {
        const owners = database.prepare(`
          SELECT thread.id FROM agent_threads thread
          WHERE NOT EXISTS (
            SELECT 1 FROM agent_hidden_threads hidden WHERE hidden.thread_id = thread.id
          )
        `).all() as Array<{ id: string }>
        if (owners.length !== 1 || owners[0]?.id !== expectedOwnerThreadId) {
          throw new Error(`Conversation database does not belong to ${expectedOwnerThreadId}.`)
        }
      }
      const root = resolve(attachmentRoot)
      const rows = database.prepare('SELECT storage_path, size FROM agent_attachments').all() as Array<{
        storage_path: string
        size: number
      }>
      for (const row of rows) {
        const path = resolve(root, row.storage_path)
        if (path === root || !path.startsWith(`${root}${sep}`)) {
          throw new Error(`Agent attachment path escapes the attachment root: ${row.storage_path}`)
        }
        if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== row.size) {
          throw new Error(`Agent attachment is missing or has an invalid size: ${row.storage_path}`)
        }
      }
      const queuedRows = database.prepare(`
        SELECT storage_path, size
        FROM agent_queued_attachments
      `).all() as Array<{ storage_path: string; size: number }>
      for (const row of queuedRows) {
        const path = resolve(root, row.storage_path)
        if (path === root || !path.startsWith(`${root}${sep}`)) {
          throw new Error(`Queued attachment path escapes the attachment root: ${row.storage_path}`)
        }
        if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== row.size) {
          throw new Error(`Queued attachment is missing or has an invalid size: ${row.storage_path}`)
        }
      }
    } finally {
      database.close()
    }
  }

  private static validateRequiredTableColumns(database: Database.Database): void {
    if (!this.requiredTableColumns) {
      // Use the actual application and framework schema builders as the source
      // of truth. Never initialize or repair the database being inspected.
      const reference = this.open(':memory:')
      try {
        const tables = reference.database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
        this.requiredTableColumns = new Map(tables.map(({ name }) => [name, schemaColumns(reference.database, name)]))
      } finally { reference.close() }
    }
    const tables = new Set((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>).map(({ name }) => name))
    for (const [table, expectedColumns] of this.requiredTableColumns) {
      if (!tables.has(table)) throw new Error(`Unsupported agent database schema: missing table ${table}.`)
      const actualColumns = new Map(schemaColumns(database, table).map((column) => [column.name, column]))
      for (const expected of expectedColumns) {
        const actual = actualColumns.get(expected.name)
        if (!actual) throw new Error(`Unsupported agent database schema: missing column ${table}.${expected.name}.`)
        if (actual.type !== expected.type || actual.notnull !== expected.notnull || actual.dflt_value !== expected.dflt_value
          || actual.pk !== expected.pk || actual.hidden !== expected.hidden) {
          throw new Error(`Unsupported agent database schema: invalid column definition ${table}.${expected.name}.`)
        }
      }
    }
  }

  private initializeSchema(): void {
    const currentVersion = this.database.pragma('user_version', { simple: true }) as number
    if (currentVersion !== 0 && currentVersion !== schemaVersion) {
      throw new Error(`Unsupported agent database schema ${currentVersion}; expected ${schemaVersion}.`)
    }
    if (currentVersion === schemaVersion) {
      this.initializeActivitySchema()
      return
    }

    this.database.exec(`
      CREATE TABLE agent_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT NOT NULL,
        model_config_id TEXT,
        model_parameter_preset_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        full_access INTEGER NOT NULL DEFAULT 0 CHECK (full_access IN (0, 1)),
        strict_approval INTEGER NOT NULL DEFAULT 0 CHECK (strict_approval IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'running', 'interrupted', 'failed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX agent_threads_updated_at_idx
        ON agent_threads (pinned DESC, updated_at DESC);

      CREATE TABLE agent_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        submission_id TEXT UNIQUE,
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        operation TEXT NOT NULL CHECK (operation IN ('agent', 'compression')),
        status TEXT NOT NULL
          CHECK (status IN ('running', 'interrupted', 'completed', 'failed', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        error TEXT,
        last_checkpoint_id TEXT,
        terminal_checkpoint_id TEXT,
        last_write_checkpoint_ns TEXT,
        last_write_checkpoint_id TEXT,
        configuration_json TEXT CHECK (configuration_json IS NULL OR json_valid(configuration_json)),
        cancellation_requested INTEGER NOT NULL DEFAULT 0
          CHECK (cancellation_requested IN (0, 1))
      );

      CREATE INDEX agent_runs_thread_id_idx
        ON agent_runs (thread_id, created_at DESC);

      PRAGMA user_version = ${schemaVersion};
    `)
    this.initializeActivitySchema()
  }



  private registerMessagePayload(threadId:string,message:BaseMessage): void {
    if (!message.id) return
    const body=this.checkpointer.getLatestMessageRecord(threadId,message.id)
    if (!body) return
    const suppliedRunId=typeof message.additional_kwargs?.anas_run_id==='string' ? message.additional_kwargs.anas_run_id : undefined
    const owningModel = ToolMessage.isInstance(message)
      ? this.database.prepare(`SELECT payload.run_id FROM agent_tool_messages call
        JOIN agent_message_payloads payload ON payload.thread_id=call.thread_id AND payload.message_id=call.model_message_id
        WHERE call.thread_id=? AND call.call_id=? ORDER BY (SELECT sequence FROM agent_runs WHERE id=call.run_id) DESC LIMIT 1`).get(threadId,message.tool_call_id) as {run_id:string|null}|undefined
      : undefined
    const currentRun = this.database.prepare("SELECT id FROM agent_runs WHERE thread_id=? AND status='running' ORDER BY sequence DESC LIMIT 1").get(threadId) as {id:string}|undefined
    const candidate = suppliedRunId ?? owningModel?.run_id ?? currentRun?.id
    const runId = candidate && this.getRun(candidate)?.threadId===threadId ? candidate : undefined
    this.database.prepare(`INSERT INTO agent_message_payloads(thread_id,message_id,run_id,record_id) VALUES(?,?,?,?)
      ON CONFLICT(thread_id,message_id) DO UPDATE SET run_id=excluded.run_id,record_id=excluded.record_id`)
      .run(threadId,message.id,runId ?? null,body.recordId)
    this.database.prepare("DELETE FROM message_references WHERE thread_id=? AND checkpoint_ns='' AND owner_kind='activity' AND owner_key=?").run(threadId,message.id)
    this.database.prepare("INSERT INTO message_references(thread_id,checkpoint_ns,owner_kind,owner_key,record_id) VALUES(?,'','activity',?,?)").run(threadId,message.id,body.recordId)
    if (!runId) return
    if (AIMessage.isInstance(message)) {
      const linked=this.database.prepare(`SELECT model.model_id FROM agent_model_activities model
        LEFT JOIN agent_model_messages message ON message.run_id=model.run_id AND message.model_id=model.model_id
        WHERE model.run_id=? AND model.subagent_id IS NULL AND (message.message_id=? OR (message.message_id IS NULL AND model.status='running'))
        ORDER BY (message.message_id IS NOT NULL) DESC,model.sequence DESC LIMIT 1`).get(runId,message.id) as {model_id:string}|undefined
      this.recordModelActivity(runId,{id:linked?.model_id ?? `message:${message.id}`,messageId:message.id,status:'completed',text:'',reasoning:'',toolCallIds:message.tool_calls?.flatMap(call=>call.id ? [call.id] : []) ?? []})
      for (const call of message.tool_calls ?? []) {
        if (!call.id) continue
        this.database.prepare(`INSERT INTO agent_tool_messages(thread_id,run_id,call_id,model_message_id) VALUES(?,?,?,?)
          ON CONFLICT(thread_id,run_id,call_id) DO UPDATE SET model_message_id=excluded.model_message_id`).run(threadId,runId,call.id,message.id)
        const tool=this.database.prepare('SELECT tool_message_id FROM agent_tool_messages WHERE thread_id=? AND run_id=? AND call_id=?').get(threadId,runId,call.id) as {tool_message_id:string|null}
        if (!tool.tool_message_id) this.recordToolActivity(runId,{id:call.id,name:call.name,args:call.args},'running')
      }
    }
    if (ToolMessage.isInstance(message)) {
      this.database.prepare(`INSERT INTO agent_tool_messages(thread_id,run_id,call_id,tool_message_id) VALUES(?,?,?,?)
        ON CONFLICT(thread_id,run_id,call_id) DO UPDATE SET tool_message_id=excluded.tool_message_id`).run(threadId,runId,message.tool_call_id,message.id)
      const payload=this.toolPayload(runId,message.tool_call_id,message.name ?? 'tool')
      this.recordToolActivity(runId,payload.call,'completed',undefined,payload.output)
    }
  }

  readRunMessages(runId:string): BaseMessage[] {
    const rows=this.database.prepare(`SELECT body.record_id,body.message_id,body.type,body.value
      FROM agent_message_payloads payload JOIN message_bodies body ON body.thread_id=payload.thread_id AND body.record_id=payload.record_id
      WHERE payload.run_id=? ORDER BY body.sequence`).all(runId) as Array<{record_id:string;message_id:string|null;type:string;value:Uint8Array}>
    return rows.map(row=>readMessageBodySync({recordId:row.record_id,messageId:row.message_id,type:row.type,value:row.value}))
  }

  readActivityMessages(runId: string, activity: AgentRunActivity): BaseMessage[] {
    const ids = new Set(activity.models.flatMap((model) => !model.subagentId && model.messageId ? [model.messageId] : []))
    const callIds = activity.tools.flatMap((tool) => tool.subagentId ? [] : [tool.call.id])
    const toolMessages = this.database.prepare(`SELECT model_message_id, tool_message_id FROM agent_tool_messages
      WHERE run_id = ? AND call_id IN (SELECT value FROM json_each(?))`).all(runId, JSON.stringify(callIds)) as Array<{
        model_message_id: string | null; tool_message_id: string | null
      }>
    for (const message of toolMessages) {
      if (message.model_message_id) ids.add(message.model_message_id)
      if (message.tool_message_id) ids.add(message.tool_message_id)
    }
    const rows = this.database.prepare(`SELECT body.record_id, body.message_id, body.type, body.value
      FROM agent_message_payloads payload JOIN message_bodies body
        ON body.thread_id = payload.thread_id AND body.record_id = payload.record_id
      WHERE payload.run_id = ? AND payload.message_id IN (SELECT value FROM json_each(?)) ORDER BY body.sequence`)
      .all(runId, JSON.stringify([...ids])) as Array<{ record_id: string; message_id: string | null; type: string; value: Uint8Array }>
    return rows.map((row) => readMessageBodySync({ recordId: row.record_id, messageId: row.message_id, type: row.type, value: row.value }))
  }

  private reconcileCompletedRun(runId: string): void {
    const messages = this.readRunMessages(runId)
    const models: DurableRootModelActivity[] = []
    const calls = new Map<string, AgentToolCall>()
    for (const message of messages) {
      if (!AIMessage.isInstance(message)) continue
      const mapped = toAgentMessage(message, `${runId}:message`)
      const toolCalls = mapped.toolCalls ?? []
      models.push({ messageId: mapped.id,
        text: mapped.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
        reasoning: mapped.content.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join(''),
        toolCalls })
      for (const call of toolCalls) calls.set(call.id, call)
    }
    const tools: DurableRootToolActivity[] = []
    for (const message of messages) {
      if (!ToolMessage.isInstance(message)) continue
      const call = calls.get(message.tool_call_id)
      if (!call) continue
      const output = this.toolPayload(runId, call.id, call.name).output
      let result = output
      if (typeof result === 'string') {
        try { result = JSON.parse(result) as unknown } catch { result = undefined }
      }
      const subagentId = result && typeof result === 'object' && 'subagent_id' in result && typeof result.subagent_id === 'string'
        ? result.subagent_id : undefined
      const args = call.args as {agent?:unknown}|undefined
      tools.push({ call, output, subagentId,
        subagentName: call.name === 'start_subagent' && typeof args?.agent === 'string' ? args.agent : undefined })
    }
    this.reconcileRootActivities(runId, { models, tools })
    this.database.prepare("DELETE FROM agent_context_summaries WHERE run_id=? AND status='running'").run(runId)
  }

  private activitySourceThread(runId:string,subagentId?:string): string {
    const source=subagentId ? this.database.prepare('SELECT child_thread_id FROM agent_subagent_calls WHERE id=?').get(subagentId) as {child_thread_id:string}|undefined : undefined
    return source?.child_thread_id ?? this.requireRun(runId).threadId
  }

  private activitySourceRun(runId: string, subagentId?: string): string {
    const source = subagentId ? this.database.prepare('SELECT child_run_id FROM agent_subagent_calls WHERE id = ?')
      .get(subagentId) as { child_run_id: string } | undefined : undefined
    return source?.child_run_id ?? runId
  }

  private messagePayload(threadId:string,messageId:string|undefined): BaseMessage|undefined {
    if (!messageId) return undefined
    const row=this.database.prepare('SELECT record_id FROM agent_message_payloads WHERE thread_id=? AND message_id=?').get(threadId,messageId) as {record_id:string}|undefined
    const body=row ? this.checkpointer.getMessageRecordById(threadId,row.record_id) : undefined
    return body ? readMessageBodySync(body) : undefined
  }

  private modelPayload(runId:string,modelId:string,messageId:string|undefined,subagentId?:string): Pick<AgentModelActivity,'text'|'reasoning'|'toolCallIds'> {
    const message=this.messagePayload(this.activitySourceThread(runId,subagentId),messageId)
    if (message && AIMessage.isInstance(message)) {
      const mapped=toAgentMessage(message,message.id ?? modelId)
      return {
        text:mapped.content.flatMap(block=>block.type==='text' ? [block.text] : []).join(''),
        reasoning:mapped.content.flatMap(block=>block.type==='reasoning' ? [block.text] : []).join(''),
        toolCallIds:message.tool_calls?.flatMap(call=>call.id ? [call.id] : []) ?? []
      }
    }
    const pending=this.transientModels.get(JSON.stringify([runId,modelId]))
    return {text:pending?.text ?? '',reasoning:pending?.reasoning ?? '',toolCallIds:pending?.toolCallIds ?? []}
  }

  private toolPayload(runId:string,callId:string,name:string,subagentId?:string): {call:AgentToolCall;output?:unknown} {
    const source=this.activitySourceThread(runId,subagentId)
    const sourceRun=this.activitySourceRun(runId,subagentId)
    const row=this.database.prepare('SELECT model_message_id,tool_message_id FROM agent_tool_messages WHERE thread_id=? AND run_id=? AND call_id=?').get(source,sourceRun,callId) as {model_message_id:string|null;tool_message_id:string|null}|undefined
    const pending=this.transientTools.get(JSON.stringify([runId,subagentId ?? null,callId]))
    const model=this.messagePayload(source,row?.model_message_id ?? undefined)
    const nativeCall=model && AIMessage.isInstance(model) ? model.tool_calls?.find(call=>call.id===callId) : undefined
    const result=this.messagePayload(source,row?.tool_message_id ?? undefined)
    let output:unknown=pending?.output
    if (result) {
      const blocks=toAgentMessage(result,result.id ?? callId).content
      const block=blocks[0]
      output=blocks.length!==1 ? blocks : block.type==='text' ? block.text : block.type==='json' ? block.value : block
    }
    return {call:{id:callId,name:nativeCall?.name ?? name,args:nativeCall?.args ?? pending?.call.args ?? {}},output}
  }

  private notifyChanged(): void {
    if (!this.options.onChanged || this.changeNotificationQueued) return
    this.changeNotificationQueued = true
    queueMicrotask(() => {
      this.changeNotificationQueued = false
      if (!this.closed) this.options.onChanged?.(this)
    })
  }

  listThreadIds(): string[] {
    return (this.database.prepare('SELECT id FROM agent_threads').all() as Array<{id:string}>).map(row => row.id)
  }

  listRunLocators(): Array<{id:string;threadId:string;submissionId?:string}> {
    return (this.database.prepare('SELECT id, thread_id, submission_id FROM agent_runs').all() as Array<{id:string;thread_id:string;submission_id:string|null}>)
      .map(row => ({id:row.id, threadId:row.thread_id, ...(row.submission_id ? {submissionId:row.submission_id} : {})}))
  }

  hasQueuedInputs(): boolean {
    return Boolean(this.database.prepare('SELECT 1 FROM agent_queued_inputs LIMIT 1').get())
  }

  private commitCurrentState(config: RunnableConfig, checkpoint: Checkpoint, _metadata: CheckpointMetadata): void {
    const threadId = config.configurable?.thread_id as string
    if ((config.configurable?.checkpoint_ns ?? '') !== '' || !this.getThread(threadId)) return
    const run = this.database.prepare("SELECT id FROM agent_runs WHERE thread_id = ? AND status = 'running' ORDER BY sequence DESC LIMIT 1").get(threadId) as {id:string}|undefined
    const messages = Array.isArray(checkpoint.channel_values.messages) ? checkpoint.channel_values.messages as BaseMessage[] : []
    const acceptsInput = run && (!this.getRunInputIntent(run.id)
      || messages.some(message=>message.additional_kwargs?.anas_run_id===run.id)
      || Object.values(checkpoint.channel_values).some(value=>value && typeof value==='object' && 'runId' in value && value.runId===run.id))
    if (run && acceptsInput) {
      const lifecycle = checkpoint.channel_values.anasRunLifecycle as {runId?:string;status?:string}|undefined
      const terminal = lifecycle?.runId === run.id && lifecycle.status === 'completed'
      this.database.prepare('UPDATE agent_runs SET last_checkpoint_id = ?, terminal_checkpoint_id = CASE WHEN ? THEN ? ELSE terminal_checkpoint_id END, cancellation_requested = CASE WHEN ? THEN 0 ELSE cancellation_requested END WHERE id = ?')
        .run(checkpoint.id, terminal ? 1 : 0, checkpoint.id, terminal ? 1 : 0, run.id)
      this.database.prepare('DELETE FROM agent_run_input_intents WHERE run_id = ?').run(run.id)
      this.database.prepare('DELETE FROM agent_run_resume_intents WHERE run_id = ?').run(run.id)
    }
    const changed = this.database.prepare(`
      SELECT state.position, state.record_id FROM state_messages state
      LEFT JOIN agent_message_index entry ON entry.thread_id = state.thread_id AND entry.position = state.position
      WHERE state.thread_id = ? AND state.checkpoint_ns = '' AND (entry.record_id IS NULL OR entry.record_id <> state.record_id)
    `).all(threadId) as Array<{position:number;record_id:string}>
    const upsert = this.database.prepare(`INSERT INTO agent_message_index(thread_id,position,record_id,message_id,run_id,visible)
      VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id,position) DO UPDATE SET record_id=excluded.record_id,message_id=excluded.message_id,run_id=excluded.run_id,visible=excluded.visible`)
    for (const row of changed) {
      const message = messages[row.position]
      if (!message) throw new Error('Current message index has no corresponding framework message.')
      const visible = HumanMessage.isInstance(message) || (AIMessage.isInstance(message) && !message.tool_calls?.length)
      upsert.run(threadId,row.position,row.record_id,message.id ?? null,message.additional_kwargs?.anas_run_id ?? null,visible ? 1 : 0)
      this.registerMessagePayload(threadId,message)
    }
    this.database.prepare('DELETE FROM agent_message_index WHERE thread_id = ? AND position >= ?').run(threadId,messages.length)
    const event = checkpoint.channel_values._summarizationEvent as {summaryMessage?:BaseMessage;cutoffIndex?:number}|undefined
    const summaryId = event?.summaryMessage?.additional_kwargs?.anas_summary_id
    if (typeof summaryId === 'string') {
      this.database.prepare(`UPDATE agent_context_summaries SET status='completed',committed_checkpoint_id=?
        WHERE summary_id=? AND status='running' AND cutoff_index=?
        AND run_id IN(SELECT id FROM agent_runs WHERE thread_id=?)`).run(checkpoint.id,summaryId,event?.cutoffIndex ?? null,threadId)
    }
  }

  private commitCurrentWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): void {
    const threadId = config.configurable?.thread_id as string
    const namespace = config.configurable?.checkpoint_ns ?? ''
    const checkpointId = config.configurable?.checkpoint_id
    const run = this.database.prepare("SELECT id FROM agent_runs WHERE thread_id = ? AND status = 'running' ORDER BY sequence DESC LIMIT 1").get(threadId) as {id:string}|undefined
    for (const [channel,value] of writes) {
      if (channel !== 'messages') continue
      for (const message of Array.isArray(value) ? value : [value]) {
        if (BaseMessage.isInstance(message)) this.registerMessagePayload(threadId,message)
      }
    }
    if (!run) return
    this.database.prepare('UPDATE agent_runs SET last_write_checkpoint_ns=?,last_write_checkpoint_id=? WHERE id=?').run(namespace,checkpointId,run.id)
    if (writes.some(([channel]) => channel === '__resume__')) {
      this.database.prepare('DELETE FROM agent_run_resume_intents WHERE run_id=?').run(run.id)
    }
    if (writes.some(([channel]) => !['__error__','__error_source_node__','__interrupt__','__resume__','__scheduled__'].includes(channel))) {
      this.database.prepare(`DELETE FROM agent_effect_journal WHERE run_id=? AND checkpoint_id=?
        AND write_checkpoint_ns=? AND task_id=? AND state='result'`).run(run.id,checkpointId,namespace,taskId)
    }
  }

  recordContextStatus(threadId: string, status: AgentContextStatus): void {
    this.database.prepare(`INSERT INTO agent_context_status(thread_id,status_json) VALUES(?,?)
      ON CONFLICT(thread_id) DO UPDATE SET status_json=excluded.status_json`).run(threadId,JSON.stringify(status))
  }

  clearContextStatus(threadId: string): void {
    this.database.prepare('DELETE FROM agent_context_status WHERE thread_id=?').run(threadId)
  }

  async readMessageWindow(threadId: string, startIndex?: number, limit = 100): Promise<{
    messages: BaseMessage[]; startIndex: number; totalCount: number; values: Record<string,unknown>; contextStatus?: AgentContextStatus
  }> {
    this.requireThread(threadId)
    const totalCount = (this.database.prepare('SELECT COUNT(*) AS count FROM agent_message_index WHERE thread_id=? AND visible=1').get(threadId) as {count:number}).count
    const size = Math.max(0,Math.floor(limit))
    const offset = startIndex === undefined ? Math.max(0,totalCount-size) : Math.min(totalCount,Math.max(0,Math.floor(startIndex)))
    const rows = this.database.prepare(`SELECT body.record_id,body.message_id,body.type,body.value FROM agent_message_index entry
      JOIN message_bodies body ON body.thread_id=entry.thread_id AND body.record_id=entry.record_id
      WHERE entry.thread_id=? AND entry.visible=1 ORDER BY entry.position LIMIT ? OFFSET ?
    `).all(threadId,startIndex===undefined ? size : totalCount-offset,offset) as Array<{record_id:string;message_id:string|null;type:string;value:Uint8Array}>
    const messages = rows.map(row=>readMessageBodySync({recordId:row.record_id,messageId:row.message_id,type:row.type,value:row.value}))
    const values: Record<string,unknown> = {}
    for (const channel of ['todos','_summarizationEvent','anasProjectRules','anasRunLifecycle']) {
      const value = await this.checkpointer.readChannel(threadId,channel)
      if (value !== undefined) values[channel]=value
    }
    const status = this.database.prepare('SELECT status_json FROM agent_context_status WHERE thread_id=?').get(threadId) as {status_json:string}|undefined
    return {messages,startIndex:offset,totalCount,values,...(status ? {contextStatus:JSON.parse(status.status_json) as AgentContextStatus} : {})}
  }

  listRunIdsFrom(threadId: string, fromRunId: string): string[] {
    const run = this.requireRun(fromRunId)
    if (run.threadId !== threadId) throw new Error('History boundary belongs to another conversation.')
    return (this.database.prepare('SELECT id FROM agent_runs WHERE thread_id=? AND sequence >= (SELECT sequence FROM agent_runs WHERE id=?) ORDER BY sequence').all(threadId,fromRunId) as Array<{id:string}>).map(row=>row.id)
  }

  async replaceMessageHistory(
    threadId: string,
    messages: BaseMessage[],
    fromRunId: string,
    replacement?: {runId:string;inputIntent:AgentRunInputIntent}
  ): Promise<{run?:AgentRun}> {
    this.assertThreadMutable(threadId, 'change its messages')
    await this.checkpointer.flush()
    const removedRunIds = this.listRunIdsFrom(threadId,fromRunId)
    const children = this.listSubagentCallsForRuns(threadId,removedRunIds)
    const checkpoint = emptyCheckpoint()
    checkpoint.channel_values = {messages,todos:[]}
    checkpoint.channel_versions = {messages:1,todos:1}
    const summary = this.database.prepare(`SELECT summary.* FROM agent_context_summaries summary
      JOIN agent_runs run ON run.id=summary.run_id
      WHERE run.thread_id=? AND run.sequence < (SELECT sequence FROM agent_runs WHERE id=?)
        AND summary.status='completed' AND summary.cutoff_index <= ? AND summary.activated_after_message_index <= ?
      ORDER BY run.sequence DESC,summary.sequence DESC LIMIT 1
    `).get(threadId,fromRunId,messages.length,messages.length) as ContextSummaryRow|undefined
    if (summary) {
      checkpoint.channel_values._summarizationEvent = {
        cutoffIndex:summary.cutoff_index,
        summaryMessage:new HumanMessage({content:summary.model_content,additional_kwargs:{anas_summary_id:summary.summary_id,lc_source:'summarization'}})
      }
      checkpoint.channel_versions._summarizationEvent=1
    }
    const inputId = replacement?.inputIntent.kind === 'regeneration'
      ? replacement.inputIntent.message.data.id : undefined
    const preserved = inputId
      ? this.database.prepare('SELECT * FROM agent_attachments WHERE thread_id=? AND message_id=?').all(threadId,inputId) as AttachmentRow[]
      : []
    const preservedIds = new Set(preserved.map(row=>row.id))
    const attachments = this.database.prepare('SELECT * FROM agent_attachments WHERE run_id IN(SELECT value FROM json_each(?))')
      .all(JSON.stringify([...removedRunIds,...children.map(child=>child.childRunId)])) as AttachmentRow[]
    let run: AgentRun|undefined
    await this.checkpointer.replaceCurrentState(threadId,checkpoint,{source:'update',step:0,parents:{}},()=>{
      for (const child of [...children].reverse()) {
        this.checkpointer.deleteThreadSync(child.childThreadId)
        this.enqueueAttachmentCleanup(child.childThreadId)
        this.database.prepare('DELETE FROM agent_threads WHERE id=?').run(child.childThreadId)
      }
      for (const runId of removedRunIds) {
        this.retainUncommittedFileEdits(runId)
        this.database.prepare('INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox(run_id) VALUES(?)').run(runId)
      }
      this.database.prepare('DELETE FROM agent_runs WHERE id IN(SELECT value FROM json_each(?))').run(JSON.stringify(removedRunIds))
      this.database.prepare('DELETE FROM agent_context_status WHERE thread_id=?').run(threadId)
      this.updateThread(threadId,{status:'idle'})
      if (replacement) {
        run=this.createRun(threadId,replacement.runId,'agent',[],replacement.inputIntent)
        const insert=this.database.prepare(`INSERT INTO agent_attachments(id,thread_id,message_id,run_id,name,mime_type,size,kind,storage_path,text_truncated,context_policy,created_at)
          VALUES(@id,@thread_id,@message_id,@run_id,@name,@mime_type,@size,@kind,@storage_path,@text_truncated,@context_policy,@created_at)`)
        for (const row of preserved) insert.run({...row,run_id:run.id})
      }
      const enqueue = this.database.prepare(`INSERT INTO agent_attachment_file_cleanup_outbox(attachment_id,thread_id,storage_path)
        VALUES(?,?,?) ON CONFLICT(attachment_id) DO NOTHING`)
      for (const attachment of attachments) if (!preservedIds.has(attachment.id)) {
        enqueue.run(attachment.id, attachment.thread_id, attachment.storage_path)
      }
    })
    this.notifyChanged()
    this.fileChanges.notifyChanged(fromRunId)
    return {run}
  }

  getActivitiesForRuns(threadId: string, runIds: string[], options: {includeUnanchored?:number} = {}): AgentRunActivity[] {
    const selected = new Set(runIds)
    if (options.includeUnanchored) {
      for (const row of this.database.prepare(`SELECT id FROM agent_runs WHERE thread_id=? AND operation='compression'
        ORDER BY sequence DESC LIMIT ?`).all(threadId,options.includeUnanchored) as Array<{id:string}>) selected.add(row.id)
    }
    return this.readActivities(threadId,[...selected])
  }

  getRunActivity(runId: string): AgentRunActivity|undefined {
    const run = this.getRun(runId)
    return run ? this.readActivities(run.threadId,[runId])[0] : undefined
  }

  getRunActivityWindow(runId: string, options: { beforeSequence?: number } = {}): AgentRunActivity {
    const run = this.requireRun(runId)
    const before = options.beforeSequence ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(before) || before < 0) throw new Error('The activity window cursor is invalid.')
    return this.readActivities(run.threadId, [runId], before)[0]
  }

  getModelActivity(runId: string, modelId: string): AgentModelActivity | undefined {
    const row = this.database.prepare(`
      SELECT model.run_id, model.model_id, message.message_id, model.sequence, ${modelRoundSql} AS model_round,
        model.subagent_id, model.status, timing.started_at, timing.completed_at
      FROM agent_model_activities model
      JOIN agent_activity_timing timing ON timing.run_id = model.run_id
        AND timing.activity_key = 'model:' || model.model_id
      LEFT JOIN agent_model_messages message ON message.run_id = model.run_id AND message.model_id = model.model_id
      WHERE model.run_id = ? AND model.model_id = ?
    `).get(runId, modelId) as ModelActivityRow | undefined
    return row ? {
      id: row.model_id, messageId: row.message_id ?? undefined, sequence: row.sequence, round: row.model_round,
      status: row.status, subagentId: row.subagent_id ?? undefined,
      ...this.modelPayload(runId, modelId, row.message_id ?? undefined, row.subagent_id ?? undefined),
      startedAt: row.started_at, completedAt: row.completed_at ?? undefined
    } : undefined
  }

  getSubagentActivity(runId: string, subagentId: string): AgentSubagentActivity | undefined {
    const row = this.database.prepare(`
      SELECT activity.activity_id, activity.name, activity.sequence, activity.parent_subagent_id, activity.output_json,
        timing.started_at, timing.completed_at, call.agent_name AS subagent_name, call.status AS subagent_status,
        call.parent_subagent_id AS subagent_parent_id, call.result_text AS subagent_result_text,
        call.error AS subagent_error, call.updated_at AS subagent_updated_at
      FROM agent_activities activity JOIN agent_activity_timing timing
        ON timing.run_id = activity.run_id AND timing.activity_key = activity.activity_key
      LEFT JOIN agent_subagent_calls call ON call.id = activity.activity_id
      WHERE activity.run_id = ? AND activity.kind = 'subagent' AND activity.activity_id = ?
    `).get(runId, subagentId) as ActivityRow | undefined
    if (!row) return undefined
    const projected = parseSubagentActivityPayload(row.output_json)
    const status = row.subagent_status ?? projected.status
    const result = row.subagent_status ? row.subagent_result_text ?? undefined : projected.result
    const error = row.subagent_status ? row.subagent_error ?? undefined : projected.error
    return {
      id: subagentId, name: row.subagent_name ?? row.name, sequence: row.sequence, status,
      parentSubagentId: (row.subagent_status ? row.subagent_parent_id : row.parent_subagent_id) ?? undefined,
      ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }),
      startedAt: row.started_at,
      completedAt: status === 'running' || status === 'interrupted' ? undefined : row.completed_at ?? row.subagent_updated_at ?? undefined
    }
  }

  listRootToolActivityIds(runId: string, status: 'running' | 'completed'): string[] {
    return (this.database.prepare(`SELECT activity_id FROM agent_activities
      WHERE run_id = ? AND kind = 'tool' AND parent_subagent_id IS NULL AND status = ?
        AND (status = 'running' OR EXISTS (SELECT 1 FROM agent_tool_messages tool
          WHERE tool.run_id = agent_activities.run_id AND tool.call_id = agent_activities.activity_id
            AND tool.tool_message_id IS NOT NULL)) ORDER BY sequence`)
      .all(runId, status) as Array<{ activity_id: string }>).map((row) => row.activity_id)
  }

  getRunProcessActivity(runId: string) {
    const count = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM agent_model_activities WHERE run_id = ? AND subagent_id IS NULL) AS models,
      (SELECT COUNT(*) FROM agent_activities WHERE run_id = ? AND kind = 'tool' AND parent_subagent_id IS NULL) AS tools
    `).get(runId, runId) as { models: number; tools: number }
    const latest = this.database.prepare(`SELECT model_id FROM agent_model_activities
      WHERE run_id = ? AND subagent_id IS NULL ORDER BY sequence DESC LIMIT 1`).get(runId) as { model_id: string } | undefined
    return {
      modelRounds: count.models, toolCalls: count.tools,
      latestModel: latest ? this.getModelActivity(runId, latest.model_id) : undefined,
      activeTools: this.listRootToolActivityIds(runId, 'running')
        .flatMap((callId) => this.getToolActivity(runId, callId) ?? [])
    }
  }

  getMessageActivitySequence(runId: string, messageId: string): number | undefined {
    const row = this.database.prepare(`
      SELECT model.sequence FROM agent_model_activities model JOIN agent_model_messages message
        ON message.run_id = model.run_id AND message.model_id = model.model_id
      WHERE model.run_id = ? AND model.subagent_id IS NULL AND message.message_id = ?
      UNION ALL
      SELECT activity.sequence FROM agent_activities activity JOIN agent_tool_messages tool
        ON tool.run_id = activity.run_id AND tool.call_id = activity.activity_id
      WHERE activity.run_id = ? AND activity.kind = 'tool' AND activity.parent_subagent_id IS NULL
        AND tool.tool_message_id = ? LIMIT 1
    `).get(runId, messageId, runId, messageId) as { sequence: number } | undefined
    return row?.sequence
  }

  getToolActivity(runId: string, callId: string, subagentId?: string): AgentToolActivity | undefined {
    const row = this.database.prepare(`
      SELECT activity.sequence, activity.name, activity.status,
        timing.started_at, timing.completed_at,
        approval.interrupt_id AS approval_interrupt_id,
        approval.action_index AS approval_action_index
      FROM agent_activities activity
      INNER JOIN agent_activity_timing timing
        ON timing.run_id = activity.run_id AND timing.activity_key = activity.activity_key
      LEFT JOIN agent_tool_approvals approval
        ON approval.run_id = activity.run_id AND approval.activity_key = activity.activity_key
      WHERE activity.run_id = ? AND activity.activity_key = ? AND activity.kind = 'tool'
    `).get(runId, `tool:${subagentId ?? 'root'}:${callId}`) as Pick<ActivityRow,
      'sequence' | 'name' | 'status' | 'started_at' | 'completed_at' | 'approval_interrupt_id' | 'approval_action_index'> | undefined
    if (!row) return undefined
    return {
      ...this.toolPayload(runId, callId, row.name, subagentId),
      sequence: row.sequence,
      status: row.status,
      subagentId,
      startedAt: row.started_at,
      completedAt: row.status === 'completed' ? row.completed_at ?? undefined : undefined,
      ...(row.approval_interrupt_id !== null && row.approval_action_index !== null
        ? { approval: { status: 'pending_approval' as const, interruptId: row.approval_interrupt_id, actionIndex: row.approval_action_index } }
        : {})
    }
  }

  listAttachmentsForMessages(threadId:string,messageIds:string[]): AgentAttachmentArtifact[] {
    if (!messageIds.length) return []
    const rows = this.database.prepare('SELECT * FROM agent_attachments WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id').all(threadId,JSON.stringify(messageIds)) as AttachmentRow[]
    return rows.map(row=>this.attachmentFromRow(row))
  }

  private initializeCheckpointTracking(): void {
    this.database.exec(`
      DROP TRIGGER IF EXISTS agent_enqueue_file_restore_cleanup;

      CREATE TRIGGER IF NOT EXISTS agent_release_effect_result
      AFTER DELETE ON agent_effect_journal
      BEGIN
        DELETE FROM message_references
        WHERE checkpoint_ns=OLD.checkpoint_ns AND owner_kind='activity'
          AND owner_key='effect:' || json_array(OLD.run_id,OLD.checkpoint_id,OLD.checkpoint_ns,OLD.task_id,OLD.call_key);
      END;

      CREATE TRIGGER agent_enqueue_file_restore_cleanup
      BEFORE DELETE ON agent_effect_journal
      WHEN OLD.tool_name = 'restore_file_edit'
      BEGIN
        INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox (run_id)
        SELECT json_extract(OLD.target_json, '$.requestId')
        WHERE OLD.effect_kind = 'file_patch'
          AND json_type(OLD.target_json, '$.requestId') = 'text';
        INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox (run_id)
        SELECT CASE
            WHEN json_type(OLD.args_json, '$.request_id') = 'text'
              AND length(trim(json_extract(OLD.args_json, '$.request_id'))) > 0
            THEN trim(json_extract(OLD.args_json, '$.request_id'))
            ELSE OLD.run_id
          END
        WHERE OLD.effect_kind = 'file_patch'
          AND json_type(OLD.args_json, '$.operation_id') = 'text';
        DELETE FROM agent_file_edit_retained_operations
        WHERE (
            OLD.effect_kind = 'file_patch'
            AND request_id = json_extract(OLD.target_json, '$.requestId')
            AND operation_id = json_extract(OLD.target_json, '$.operationId')
          )
          OR (
            request_id = CASE
              WHEN json_type(OLD.args_json, '$.request_id') = 'text'
                AND length(trim(json_extract(OLD.args_json, '$.request_id'))) > 0
              THEN trim(json_extract(OLD.args_json, '$.request_id'))
              ELSE OLD.run_id
            END
            AND operation_id = json_extract(OLD.args_json, '$.operation_id')
          );
      END;

    `)
  }

  private initializeActivitySchema(): void {
    const managedCallTableExists = this.database.prepare(`
      SELECT 1
      FROM sqlite_schema
      WHERE type = 'table' AND name = 'agent_managed_calls'
    `).get() !== undefined
    if (managedCallTableExists) assertManagedCallStorageIntegrity(this.database)
    if (hasTables(this.database, [
      'agent_subagent_calls',
      'agent_subagent_observations'
    ])) {
      assertSubagentStorageIntegrity(this.database)
    }
    if (hasTables(this.database, [
      'agent_threads',
      'agent_attachment_cleanup_outbox'
    ])) {
      assertAttachmentCleanupOutboxIntegrity(this.database)
    }

    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_message_payloads (
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL, run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE, record_id TEXT NOT NULL,
        PRIMARY KEY(thread_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS agent_tool_messages (
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        call_id TEXT NOT NULL,model_message_id TEXT,tool_message_id TEXT,
        PRIMARY KEY(thread_id,run_id,call_id)
      );
      CREATE TRIGGER IF NOT EXISTS agent_release_message_payload
      AFTER DELETE ON agent_message_payloads
      BEGIN
        DELETE FROM message_references
        WHERE thread_id=OLD.thread_id AND checkpoint_ns='' AND owner_kind='activity' AND owner_key=OLD.message_id;
        UPDATE agent_tool_messages SET model_message_id=NULL
        WHERE thread_id=OLD.thread_id AND model_message_id=OLD.message_id;
        UPDATE agent_tool_messages SET tool_message_id=NULL
        WHERE thread_id=OLD.thread_id AND tool_message_id=OLD.message_id;
        DELETE FROM agent_tool_messages
        WHERE thread_id=OLD.thread_id AND model_message_id IS NULL AND tool_message_id IS NULL;
      END;
      CREATE TABLE IF NOT EXISTS agent_message_index (
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,record_id TEXT NOT NULL,message_id TEXT,run_id TEXT,visible INTEGER NOT NULL,
        PRIMARY KEY(thread_id,position)
      );
      CREATE INDEX IF NOT EXISTS agent_message_visible_idx ON agent_message_index(thread_id,visible,position);
      CREATE TABLE IF NOT EXISTS agent_context_status (
        thread_id TEXT PRIMARY KEY REFERENCES agent_threads(id) ON DELETE CASCADE,status_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_activities (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        activity_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('tool', 'subagent')),
        activity_id TEXT NOT NULL,
        parent_subagent_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        output_json TEXT,
        PRIMARY KEY (run_id, activity_key)
      );

      CREATE INDEX IF NOT EXISTS agent_activities_run_sequence_idx
        ON agent_activities (run_id, sequence);

      CREATE TABLE IF NOT EXISTS agent_tool_approvals (
        run_id TEXT NOT NULL,
        activity_key TEXT NOT NULL,
        interrupt_id TEXT NOT NULL,
        action_index INTEGER NOT NULL CHECK (action_index >= 0),
        PRIMARY KEY (run_id, activity_key),
        UNIQUE (run_id, interrupt_id, action_index),
        FOREIGN KEY (run_id, activity_key)
          REFERENCES agent_activities (run_id, activity_key)
          ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_model_activities (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        subagent_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        PRIMARY KEY (run_id, model_id)
      );

      CREATE INDEX IF NOT EXISTS agent_model_activities_run_sequence_idx
        ON agent_model_activities (run_id, sequence);

      CREATE INDEX IF NOT EXISTS agent_model_activities_run_subagent_sequence_idx
        ON agent_model_activities (run_id, subagent_id, sequence);

      CREATE TABLE IF NOT EXISTS agent_model_messages (
        run_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (run_id, model_id),
        FOREIGN KEY (run_id, model_id)
          REFERENCES agent_model_activities (run_id, model_id)
          ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS agent_model_messages_message_idx
        ON agent_model_messages (message_id);

      CREATE TABLE IF NOT EXISTS agent_activity_timing (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        activity_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        PRIMARY KEY (run_id, activity_key)
      );

      CREATE TABLE IF NOT EXISTS agent_context_summaries (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        summary_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed')),
        summary_text TEXT NOT NULL DEFAULT '',
        model_content TEXT NOT NULL DEFAULT '',
        committed_checkpoint_id TEXT,
        cutoff_index INTEGER,
        activated_after_message_index INTEGER,
        covered_through_message_id TEXT,
        first_preserved_message_id TEXT,
        input_tokens_before INTEGER,
        input_tokens_after INTEGER,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, summary_id)
      );

      CREATE INDEX IF NOT EXISTS agent_context_summaries_run_sequence_idx
        ON agent_context_summaries (run_id, sequence);

      CREATE TABLE IF NOT EXISTS agent_memory_recalls (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        recall_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        query TEXT NOT NULL CHECK (length(query) > 0),
        prompt_text TEXT NOT NULL CHECK (length(prompt_text) > 0),
        memory_count INTEGER NOT NULL CHECK (memory_count > 0),
        agent_name TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, recall_id)
      );

      CREATE INDEX IF NOT EXISTS agent_memory_recalls_run_sequence_idx
        ON agent_memory_recalls (run_id, sequence);

      CREATE TABLE IF NOT EXISTS agent_attachments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        message_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('image', 'text', 'binary')),
        storage_path TEXT NOT NULL,
        text_truncated INTEGER NOT NULL DEFAULT 0 CHECK (text_truncated IN (0, 1)),
        context_policy TEXT NOT NULL DEFAULT 'one_turn'
          CHECK (context_policy IN ('one_turn', 'conversation')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_attachments_thread_message_idx
        ON agent_attachments (thread_id, message_id, created_at);

      CREATE INDEX IF NOT EXISTS agent_attachments_run_idx
        ON agent_attachments (run_id);

      CREATE TABLE IF NOT EXISTS agent_queued_inputs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        text TEXT NOT NULL CHECK (length(text) > 0),
        display_text TEXT NOT NULL CHECK (length(display_text) > 0),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'failed')),
        error TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_queued_inputs_thread_created_idx
        ON agent_queued_inputs (thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS agent_queued_attachments (
        id TEXT PRIMARY KEY,
        queued_input_id TEXT NOT NULL REFERENCES agent_queued_inputs(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        kind TEXT NOT NULL CHECK (kind IN ('image', 'text', 'binary')),
        storage_path TEXT NOT NULL,
        text_truncated INTEGER NOT NULL DEFAULT 0 CHECK (text_truncated IN (0, 1)),
        context_policy TEXT NOT NULL DEFAULT 'one_turn'
          CHECK (context_policy IN ('one_turn', 'conversation')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS agent_queued_attachments_input_idx
        ON agent_queued_attachments (queued_input_id, created_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_id_thread_idx
        ON agent_runs (id, thread_id);

      CREATE TABLE IF NOT EXISTS agent_managed_calls (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('shell', 'http', 'builtin', 'mcp', 'custom')),
        summary TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('preparing', 'running', 'completed', 'failed', 'cancelled', 'uncertain')),
        result_text TEXT,
        outcome_json TEXT,
        error TEXT,
        output_chars INTEGER NOT NULL DEFAULT 0 CHECK (output_chars >= 0),
        progress_current REAL CHECK (progress_current >= 0),
        progress_total REAL CHECK (progress_total >= 0),
        progress_unit TEXT,
        next_output_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_output_sequence >= 1),
        dispatched_at TEXT,
        detached_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (run_id, thread_id)
          REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS agent_managed_calls_id_thread_idx
        ON agent_managed_calls (id, thread_id);

      CREATE TRIGGER IF NOT EXISTS agent_release_managed_call_result
      AFTER DELETE ON agent_managed_calls
      BEGIN
        DELETE FROM message_references WHERE thread_id=OLD.thread_id AND checkpoint_ns=''
          AND owner_kind='activity' AND owner_key='managed-call:' || OLD.id;
      END;

      CREATE INDEX IF NOT EXISTS agent_managed_calls_thread_created_idx
        ON agent_managed_calls (thread_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS agent_managed_calls_status_idx
        ON agent_managed_calls (status, updated_at);

      CREATE INDEX IF NOT EXISTS agent_managed_calls_run_detached_idx
        ON agent_managed_calls (run_id, detached_at);

      CREATE INDEX IF NOT EXISTS agent_managed_calls_thread_detached_idx
        ON agent_managed_calls (thread_id, detached_at, created_at, id);

      CREATE TABLE IF NOT EXISTS agent_managed_call_output (
        call_id TEXT NOT NULL REFERENCES agent_managed_calls(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'progress')),
        start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
        end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
        text TEXT NOT NULL CHECK (length(text) > 0),
        PRIMARY KEY (call_id, sequence),
        UNIQUE (call_id, start_offset)
      );

      CREATE INDEX IF NOT EXISTS agent_managed_call_output_range_idx
        ON agent_managed_call_output (call_id, start_offset, end_offset);

      CREATE TABLE IF NOT EXISTS agent_managed_call_observations (
        call_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (call_id, run_id),
        FOREIGN KEY (call_id, thread_id)
          REFERENCES agent_managed_calls(id, thread_id) ON DELETE CASCADE,
        FOREIGN KEY (run_id, thread_id)
          REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS agent_managed_call_observations_run_idx
        ON agent_managed_call_observations (run_id, call_id);

      CREATE TABLE IF NOT EXISTS agent_hidden_threads (
        thread_id TEXT PRIMARY KEY REFERENCES agent_threads(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind = 'subagent')
      );

      CREATE TABLE IF NOT EXISTS agent_subagent_calls (
        id TEXT PRIMARY KEY,
        owner_thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        parent_thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        parent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        parent_subagent_id TEXT,
        child_thread_id TEXT NOT NULL UNIQUE REFERENCES agent_threads(id) ON DELETE CASCADE,
        child_run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id) ON DELETE CASCADE,
        agent_name TEXT NOT NULL CHECK (length(agent_name) > 0),
        config_json TEXT NOT NULL,
        description TEXT NOT NULL CHECK (length(description) > 0),
        status TEXT NOT NULL
          CHECK (status IN ('running', 'interrupted', 'completed', 'failed', 'cancelled')),
        result_text TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (parent_run_id, parent_thread_id)
          REFERENCES agent_runs(id, thread_id) ON DELETE CASCADE,
        FOREIGN KEY (parent_subagent_id)
          REFERENCES agent_subagent_calls(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS agent_subagent_calls_owner_created_idx
        ON agent_subagent_calls (owner_thread_id, created_at, id);

      CREATE INDEX IF NOT EXISTS agent_subagent_calls_parent_run_idx
        ON agent_subagent_calls (parent_run_id, created_at, id);

      CREATE TABLE IF NOT EXISTS agent_subagent_observations (
        subagent_id TEXT NOT NULL REFERENCES agent_subagent_calls(id) ON DELETE CASCADE,
        observing_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (subagent_id, observing_run_id)
      );

      CREATE TABLE IF NOT EXISTS agent_run_background_cleanup (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'unconfirmed')),
        report TEXT NOT NULL
      );

      UPDATE agent_run_background_cleanup
      SET status = 'unconfirmed',
          report = report || char(10) || 'Background cleanup finished with unconfirmed outcomes.'
      WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS agent_managed_call_cleanup (
        call_id TEXT PRIMARY KEY REFERENCES agent_managed_calls(id) ON DELETE CASCADE,
        cleanup_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_subagent_cleanup (
        subagent_id TEXT PRIMARY KEY REFERENCES agent_subagent_calls(id) ON DELETE CASCADE,
        cleanup_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
        started_at TEXT NOT NULL
      );

      UPDATE agent_managed_calls
      SET status = CASE WHEN status = 'preparing' THEN 'failed' ELSE 'uncertain' END,
          error = CASE
            WHEN status = 'preparing' THEN 'The application stopped before the operation was dispatched.'
            ELSE 'The application stopped while the operation was running; its final outcome is unknown.'
          END,
          detached_at = CASE
            WHEN status = 'running' THEN COALESCE(
              detached_at,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            ELSE detached_at
          END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status IN ('preparing', 'running');

      -- Deliberately has no foreign key: file-edit records may still require
      -- cleanup after their run or thread metadata has been deleted.
      CREATE TABLE IF NOT EXISTS agent_file_edit_cleanup_outbox (
        run_id TEXT PRIMARY KEY
      );

      -- Deliberately has no foreign key: archived files may still require
      -- cleanup after their thread metadata has been deleted.
      CREATE TABLE IF NOT EXISTS agent_attachment_cleanup_outbox (
        thread_id TEXT PRIMARY KEY
      );

      -- History replacement can remove individual attachments while their
      -- conversation remains live. Keep cleanup independent of deleted runs.
      CREATE TABLE IF NOT EXISTS agent_attachment_file_cleanup_outbox (
        attachment_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        storage_path TEXT NOT NULL
      );

      -- Deliberately has no foreign key: an uncertain file edit must remain
      -- discoverable after its originating run has been cancelled or deleted.
      CREATE TABLE IF NOT EXISTS agent_file_edit_retained_operations (
        request_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        PRIMARY KEY (request_id, operation_id)
      );


      CREATE TABLE IF NOT EXISTS agent_run_resume_intents (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        interrupt_id TEXT NOT NULL,
        response_json TEXT NOT NULL CHECK (json_valid(response_json)),
        PRIMARY KEY (run_id, interrupt_id)
      );

      CREATE TABLE IF NOT EXISTS agent_run_input_intents (
        run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
        input_json TEXT NOT NULL CHECK (json_valid(input_json))
      );

      CREATE TABLE IF NOT EXISTS agent_effect_journal (
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        checkpoint_id TEXT NOT NULL CHECK (length(checkpoint_id) > 0),
        checkpoint_ns TEXT NOT NULL,
        write_checkpoint_ns TEXT NOT NULL,
        task_id TEXT NOT NULL CHECK (length(task_id) > 0),
        call_key TEXT NOT NULL CHECK (length(call_key) > 0),
        input_hash TEXT NOT NULL CHECK (length(input_hash) > 0),
        call_index INTEGER NOT NULL CHECK (call_index >= 0),
        tool_call_id TEXT CHECK (tool_call_id IS NULL OR length(tool_call_id) > 0),
        tool_name TEXT NOT NULL CHECK (length(tool_name) > 0),
        args_json TEXT NOT NULL CHECK (json_valid(args_json)),
        recovery_mode TEXT NOT NULL CHECK (recovery_mode IN ('confirm', 'idempotent')),
        state TEXT NOT NULL CHECK (state IN ('prepared', 'intent', 'result')),
        effect_attempt INTEGER NOT NULL DEFAULT 0 CHECK (effect_attempt >= 0),
        confirmation_count INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_count >= 0),
        automatic_retry_count INTEGER NOT NULL DEFAULT 0
          CHECK (automatic_retry_count >= 0),
        effect_kind TEXT CHECK (effect_kind IS NULL OR length(effect_kind) > 0),
        target_json TEXT CHECK (target_json IS NULL OR json_valid(target_json)),
        idempotency_fingerprint TEXT
          CHECK (idempotency_fingerprint IS NULL OR length(idempotency_fingerprint) = 64),
        result_type TEXT CHECK (result_type IS NULL OR length(result_type) > 0),
        result_blob BLOB,
        PRIMARY KEY (
          run_id,
          checkpoint_id,
          checkpoint_ns,
          task_id,
          call_key,
          input_hash
        ),
        UNIQUE (run_id, checkpoint_id, checkpoint_ns, task_id, call_key),
        CHECK (
          (effect_kind IS NULL AND target_json IS NULL AND idempotency_fingerprint IS NULL)
          OR (effect_kind IS NOT NULL AND target_json IS NOT NULL)
        ),
        CHECK (
          (result_type IS NULL AND result_blob IS NULL)
          OR (result_type IS NOT NULL AND result_blob IS NOT NULL)
        ),
        CHECK (recovery_mode = 'confirm' OR confirmation_count = 0),
        CHECK (recovery_mode = 'idempotent' OR automatic_retry_count = 0),
        CHECK (
          (
            state = 'prepared'
            AND result_type IS NULL
            AND (
              (
                effect_attempt = 0
                AND effect_kind IS NULL
                AND target_json IS NULL
                AND idempotency_fingerprint IS NULL
              )
              OR (
                effect_attempt >= 1
                AND effect_kind IS NOT NULL
                AND target_json IS NOT NULL
              )
            )
          )
          OR (
            state = 'intent'
            AND effect_attempt >= 1
            AND effect_kind IS NOT NULL
            AND result_type IS NULL
          )
          OR (
            state = 'result'
            AND result_type IS NOT NULL
          )
        )
      );

      CREATE INDEX IF NOT EXISTS agent_effect_journal_run_state_idx
        ON agent_effect_journal (run_id, state);
    `)
    if (!managedCallTableExists) assertManagedCallStorageIntegrity(this.database)
    assertSubagentStorageIntegrity(this.database)
    assertCleanupStorageIntegrity(this.database)
  }

  private recoverAbandonedRuns(): void {
    const now = timestamp()
    const recover = this.database.transaction(() => {
      const abandoned = this.database.prepare(`
        SELECT id, thread_id
        FROM agent_runs
        WHERE status = 'running'
        ORDER BY rowid ASC
      `).all() as Array<{
        id: string
        thread_id: string
      }>
      const finishRun = this.database.prepare(`
        UPDATE agent_runs
        SET status = @status,
            updated_at = @updatedAt,
            error = @error,
            terminal_checkpoint_id = CASE
              WHEN @status = 'completed' THEN terminal_checkpoint_id
              ELSE NULL
            END
        WHERE id = @id AND status = 'running'
      `)
      const enqueueFileEditCleanup = this.database.prepare(`
        INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox (run_id)
        VALUES (?)
      `)
      const discardResumeIntent = this.database.prepare(`
        DELETE FROM agent_run_resume_intents
        WHERE run_id = ?
      `)
      const discardInputIntent = this.database.prepare(`
        DELETE FROM agent_run_input_intents
        WHERE run_id = ?
      `)
      const discardToolEffects = this.database.prepare(`
        DELETE FROM agent_effect_journal
        WHERE run_id = ?
      `)
      const finishThread = this.database.prepare(`
        UPDATE agent_threads
        SET status = ?, updated_at = ?
        WHERE id = ?
      `)
      for (const run of abandoned) {
        const durability = this.classifyRunningRun(run.id)
        const status: AgentRunStatus | undefined =
          durability === 'terminal' ? 'completed' :
            durability === 'cancellation' || durability === 'no_progress' ? 'cancelled' :
              durability === 'error' ? 'failed' :
                undefined
        if (!status) continue
        finishRun.run({
          id: run.id,
          status,
          updatedAt: now,
          error:
            durability === 'no_progress'
              ? 'Application stopped before the run reached a durable checkpoint.'
              : durability === 'error'
                ? this.projectRulesFailure(run.id) ?? 'A framework task failed at the durable checkpoint.'
                : null
        })
        discardResumeIntent.run(run.id)
        discardInputIntent.run(run.id)
        this.retainUncommittedFileEdits(run.id)
        discardToolEffects.run(run.id)
        enqueueFileEditCleanup.run(run.id)
        this.reconcileCompletedRun(run.id)

        const threadStatus: AgentThreadStatus =
          status === 'failed' ? 'failed' : 'idle'
        finishThread.run(threadStatus, now, run.thread_id)
      }

      // A child run can reach a terminal state before its owning call is
      // projected. Reconcile that durable child state regardless of whether
      // the parent remains resumable.
      const terminalChildren = this.database.prepare(`
        SELECT call.id, call.owner_thread_id, call.child_run_id, call.child_thread_id,
          child_run.status AS child_status, child_run.error AS child_error
        FROM agent_subagent_calls call
        INNER JOIN agent_runs child_run ON child_run.id = call.child_run_id
        WHERE call.status IN ('running', 'interrupted')
          AND child_run.status IN ('completed', 'failed', 'cancelled')
        ORDER BY call.rowid ASC
      `)

      // A subagent is owned by the parent run that launched it. If the app
      // stopped after that parent became terminal but before its finally block
      // cancelled an active child, retaining the child would create a hidden
      // run with no live supervisor. Cancel the whole descendant chain; each
      // newly-cancelled child run may itself own more children.
      const abandonedChildren = this.database.prepare(`
        SELECT call.id, call.owner_thread_id, call.child_run_id, call.child_thread_id,
          child_run.status AS child_status, child_run.error AS child_error
        FROM agent_subagent_calls call
        INNER JOIN agent_runs parent_run ON parent_run.id = call.parent_run_id
        INNER JOIN agent_runs child_run ON child_run.id = call.child_run_id
        WHERE call.status IN ('running', 'interrupted')
          AND parent_run.status IN ('completed', 'failed', 'cancelled')
          AND child_run.status IN ('running', 'interrupted')
        ORDER BY call.rowid ASC
      `)
      const cancelChildRun = this.database.prepare(`
        UPDATE agent_runs
        SET status = 'cancelled',
            updated_at = ?,
            error = NULL,
            terminal_checkpoint_id = NULL,
            cancellation_requested = 1
        WHERE id = ? AND status IN ('running', 'interrupted')
      `)
      const finishChildCall = this.database.prepare(`
        UPDATE agent_subagent_calls
        SET status = @status,
            result_text = NULL,
            error = @error,
            updated_at = @updatedAt
        WHERE id = @id AND status IN ('running', 'interrupted')
      `)

      type RecoverableChildCall = {
        id: string
        owner_thread_id: string
        child_run_id: string
        child_thread_id: string
        child_status: AgentRunStatus
        child_error: string | null
      }
      const settleTerminalChildCall = (child: RecoverableChildCall): void => {
        const callStatus: Exclude<AgentSubagentCallStatus, 'running' | 'interrupted'> =
          child.child_status === 'failed'
            ? 'failed'
            : child.child_status === 'completed'
              ? 'completed'
              : 'cancelled'
        const finished = finishChildCall.run({
          id: child.id,
          status: callStatus,
          error: callStatus === 'failed' ? child.child_error ?? 'Subagent run failed.' : null,
          updatedAt: now
        })
        if (finished.changes === 0) return
        const activity = this.recordSubagentActivityForCall(
          this.requireSubagentCall(child.id, child.owner_thread_id)
        )
        this.settleProjectedActivitiesForSubagent(
          child.id,
          activity.completedAt ?? now
        )
      }

      for (const child of terminalChildren.all() as RecoverableChildCall[]) {
        settleTerminalChildCall(child)
      }

      while (true) {
        const children = abandonedChildren.all() as RecoverableChildCall[]
        if (children.length === 0) break
        for (const child of children) {
          cancelChildRun.run(now, child.child_run_id)
          discardResumeIntent.run(child.child_run_id)
          discardInputIntent.run(child.child_run_id)
          this.retainUncommittedFileEdits(child.child_run_id)
          discardToolEffects.run(child.child_run_id)
          enqueueFileEditCleanup.run(child.child_run_id)

          finishThread.run('idle', now, child.child_thread_id)
          settleTerminalChildCall({
            ...child,
            child_status: 'cancelled',
            child_error: null
          })
        }
      }
      this.reconcileMissingSubagentAncestorActivities()
    })
    recover()
  }

  private reconcileMissingSubagentAncestorActivities(targetRunId?: string): void {
    const projections = this.database.prepare(`
      WITH RECURSIVE ancestor_projections (
        subagent_id,
        ancestor_subagent_id,
        target_run_id,
        depth
      ) AS (
        SELECT
          child.id,
          parent.id,
          parent.parent_run_id,
          1
        FROM agent_subagent_calls AS child
        INNER JOIN agent_subagent_calls AS parent
          ON parent.id = child.parent_subagent_id

        UNION ALL

        SELECT
          projection.subagent_id,
          parent.id,
          parent.parent_run_id,
          projection.depth + 1
        FROM ancestor_projections AS projection
        INNER JOIN agent_subagent_calls AS ancestor
          ON ancestor.id = projection.ancestor_subagent_id
        INNER JOIN agent_subagent_calls AS parent
          ON parent.id = ancestor.parent_subagent_id
      )
      SELECT
        projection.target_run_id,
        call.id AS subagent_id,
        call.parent_subagent_id,
        call.agent_name,
        call.status AS call_status,
        call.result_text,
        call.error,
        call.created_at,
        call.updated_at,
        source_timing.started_at AS source_started_at,
        source_timing.completed_at AS source_completed_at,
        target.sequence AS target_sequence,
        target_timing.started_at AS target_started_at
      FROM ancestor_projections AS projection
      INNER JOIN agent_subagent_calls AS call
        ON call.id = projection.subagent_id
      LEFT JOIN agent_activities AS source
        ON source.run_id = call.parent_run_id
        AND source.activity_key = 'subagent:' || call.id
        AND source.kind = 'subagent'
      LEFT JOIN agent_activity_timing AS source_timing
        ON source_timing.run_id = source.run_id
        AND source_timing.activity_key = source.activity_key
      LEFT JOIN agent_activities AS target
        ON target.run_id = projection.target_run_id
        AND target.activity_key = 'subagent:' || call.id
      LEFT JOIN agent_activity_timing AS target_timing
        ON target_timing.run_id = target.run_id
        AND target_timing.activity_key = target.activity_key
      WHERE (? IS NULL OR projection.target_run_id = ?)
        AND (
          target.activity_key IS NULL
          OR target_timing.activity_key IS NULL
        )
      ORDER BY
        projection.target_run_id ASC,
        call.created_at ASC,
        call.rowid ASC,
        projection.depth ASC
    `).all(targetRunId ?? null, targetRunId ?? null) as Array<{
      target_run_id: string
      subagent_id: string
      parent_subagent_id: string
      agent_name: string
      call_status: AgentSubagentCallStatus
      result_text: string | null
      error: string | null
      created_at: string
      updated_at: string
      source_started_at: string | null
      source_completed_at: string | null
      target_sequence: number | null
      target_started_at: string | null
    }>
    const insertActivity = this.database.prepare(`
      INSERT INTO agent_activities (
        run_id,
        activity_key,
        sequence,
        kind,
        activity_id,
        parent_subagent_id,
        name,
        status,
        output_json
      ) VALUES (?, ?, ?, 'subagent', ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, activity_key) DO NOTHING
    `)
    const insertTiming = this.database.prepare(`
      INSERT INTO agent_activity_timing (
        run_id,
        activity_key,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (run_id, activity_key) DO NOTHING
    `)
    for (const projection of projections) {
      const activityKey = `subagent:${projection.subagent_id}`
      const terminal = projection.call_status === 'completed'
        || projection.call_status === 'failed'
        || projection.call_status === 'cancelled'
      const activityStatus = terminal ? 'completed' : 'running'
      const outputJson = serializeValue({ status: projection.call_status } satisfies SubagentActivityPayload)
      if (projection.target_sequence === null) {
        insertActivity.run(
          projection.target_run_id,
          activityKey,
          this.nextActivitySequence(projection.target_run_id),
          projection.subagent_id,
          projection.parent_subagent_id,
          projection.agent_name,
          activityStatus,
          outputJson
        )
      }
      if (projection.target_started_at === null) {
        insertTiming.run(
          projection.target_run_id,
          activityKey,
          projection.source_started_at ?? projection.created_at,
          projection.source_completed_at ?? (terminal ? projection.updated_at : null)
        )
      }
    }
  }

  createSubagentCall(input: {
    id: string
    ownerThreadId: string
    parentThreadId: string
    parentRunId: string
    parentSubagentId?: string
    childThreadId: string
    childRunId: string
    config: SubagentConfig
    description: string
    childThread: AgentThreadCreate
  }, armEffect?: () => void): AgentSubagentCallRecord {
    this.notifyChanged()
    requireNonEmptyText(input.id, 'Subagent ID')
    requireNonEmptyText(input.ownerThreadId, 'Subagent owner thread ID')
    requireNonEmptyText(input.parentThreadId, 'Subagent parent thread ID')
    requireNonEmptyText(input.parentRunId, 'Subagent parent run ID')
    requireNonEmptyText(input.childThreadId, 'Subagent child thread ID')
    requireNonEmptyText(input.childRunId, 'Subagent child run ID')
    requireNonEmptyText(input.description, 'Subagent description')
    const config = normalizeSubagentConfigSnapshot(input.config)
    const parentRun = this.requireRun(input.parentRunId)
    if (parentRun.threadId !== input.parentThreadId) {
      throw new Error(`Run ${input.parentRunId} does not belong to thread ${input.parentThreadId}.`)
    }
    if (parentRun.status !== 'running') {
      throw new Error(`Run ${input.parentRunId} is not accepting subagents.`)
    }
    const ownerThread = this.requireThread(input.ownerThreadId)
    if (input.parentSubagentId) {
      const parentSubagent = this.requireSubagentCall(
        input.parentSubagentId,
        input.ownerThreadId
      )
      if (
        parentSubagent.childThreadId !== input.parentThreadId
        || parentSubagent.childRunId !== input.parentRunId
      ) {
        throw new Error(`Subagent ${input.parentSubagentId} does not own run ${input.parentRunId}.`)
      }
    } else if (input.ownerThreadId !== input.parentThreadId) {
      throw new Error('A root subagent call must be started by its owning conversation.')
    }
    if (
      (input.childThread.projectId ?? DEFAULT_WORKSPACE_PROJECT_ID)
      !== ownerThread.projectId
    ) {
      throw new Error('A subagent thread must belong to its owning conversation project.')
    }
    if (this.getThread(input.childThreadId)) {
      throw new Error(`Thread ${input.childThreadId} already exists.`)
    }
    if (this.getRun(input.childRunId)) {
      throw new Error(`Run ${input.childRunId} already exists.`)
    }
    const duplicateCall = this.database.prepare(`
      SELECT 1 FROM agent_subagent_calls WHERE id = ?
    `).get(input.id)
    if (duplicateCall) throw new Error(`Subagent ${input.id} already exists.`)
    defaultTitle(input.childThread.title)
    accessModeColumns(input.childThread.accessMode ?? 'read_only_allowed')
    const now = timestamp()
    return this.database.transaction(() => {
      armEffect?.()
      this.createThread(input.childThread, input.childThreadId)
      this.database.prepare(`
        INSERT INTO agent_hidden_threads (thread_id, kind)
        VALUES (?, 'subagent')
      `).run(input.childThreadId)
      this.createRun(
        input.childThreadId,
        input.childRunId,
        'agent',
        [],
        { kind: 'user', text: input.description }
      )
      this.database.prepare(`
        INSERT INTO agent_subagent_calls (
          id, owner_thread_id, parent_thread_id, parent_run_id,
          parent_subagent_id, child_thread_id, child_run_id,
          agent_name, config_json, description, status, result_text, error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?)
      `).run(
        input.id,
        input.ownerThreadId,
        input.parentThreadId,
        input.parentRunId,
        input.parentSubagentId ?? null,
        input.childThreadId,
        input.childRunId,
        config.name,
        serializeValue(config),
        input.description,
        now,
        now
      )
      const call = this.requireSubagentCall(input.id, input.ownerThreadId)
      this.recordSubagentActivityForCall(call)
      return call
    })()
  }

  getSubagentCall(
    subagentId: string,
    ownerThreadId: string
  ): AgentSubagentCallRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, owner_thread_id, parent_thread_id, parent_run_id,
             parent_subagent_id, child_thread_id, child_run_id,
             agent_name, config_json, description, status, result_text, error,
             created_at, updated_at
      FROM agent_subagent_calls
      WHERE id = ? AND owner_thread_id = ?
    `).get(subagentId, ownerThreadId) as SubagentCallRow | undefined
    return row ? subagentCallFromRow(row) : undefined
  }

  getSubagentCallByChildRunId(childRunId: string): AgentSubagentCallRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, owner_thread_id, parent_thread_id, parent_run_id,
             parent_subagent_id, child_thread_id, child_run_id,
             agent_name, config_json, description, status, result_text, error,
             created_at, updated_at
      FROM agent_subagent_calls
      WHERE child_run_id = ?
    `).get(childRunId) as SubagentCallRow | undefined
    return row ? subagentCallFromRow(row) : undefined
  }

  getSubagentCallByChildThreadId(childThreadId: string): AgentSubagentCallRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, owner_thread_id, parent_thread_id, parent_run_id,
             parent_subagent_id, child_thread_id, child_run_id,
             agent_name, config_json, description, status, result_text, error,
             created_at, updated_at
      FROM agent_subagent_calls
      WHERE child_thread_id = ?
    `).get(childThreadId) as SubagentCallRow | undefined
    return row ? subagentCallFromRow(row) : undefined
  }

  listSubagentCalls(ownerThreadId: string): AgentSubagentCallRecord[] {
    const rows = this.database.prepare(`
      SELECT id, owner_thread_id, parent_thread_id, parent_run_id,
             parent_subagent_id, child_thread_id, child_run_id,
             agent_name, config_json, description, status, result_text, error,
             created_at, updated_at
      FROM agent_subagent_calls
      WHERE owner_thread_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(ownerThreadId) as SubagentCallRow[]
    return rows.map(subagentCallFromRow)
  }

  listSubagentCallsForParentRun(parentRunId: string): AgentSubagentCallRecord[] {
    const rows = this.database.prepare(`
      SELECT id, owner_thread_id, parent_thread_id, parent_run_id,
             parent_subagent_id, child_thread_id, child_run_id,
             agent_name, config_json, description, status, result_text, error,
             created_at, updated_at
      FROM agent_subagent_calls
      WHERE parent_run_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(parentRunId) as SubagentCallRow[]
    return rows.map(subagentCallFromRow)
  }

  listCompletedSubagentCallsWithoutResult(): AgentSubagentCallRecord[] {
    const rows = this.database.prepare(`
      SELECT id, owner_thread_id, parent_thread_id, parent_run_id,
             parent_subagent_id, child_thread_id, child_run_id,
             agent_name, config_json, description, status, result_text, error,
             created_at, updated_at
      FROM agent_subagent_calls
      WHERE status = 'completed' AND result_text IS NULL
      ORDER BY created_at ASC, id ASC
    `).all() as SubagentCallRow[]
    return rows.map(subagentCallFromRow)
  }

  recordCompletedSubagentResult(
    subagentId: string,
    ownerThreadId: string,
    result: string
  ): { call: AgentSubagentCallRecord; activity: AgentSubagentActivity } {
    return this.database.transaction(() => {
      const existing = this.requireSubagentCall(subagentId, ownerThreadId)
      if (existing.status !== 'completed') {
        throw new Error(`Subagent ${subagentId} is not completed.`)
      }
      this.database.prepare(`
        UPDATE agent_subagent_calls
        SET result_text = ?, updated_at = ?
        WHERE id = ?
          AND owner_thread_id = ?
          AND status = 'completed'
          AND result_text IS NULL
      `).run(result, timestamp(), subagentId, ownerThreadId)
      const call = this.requireSubagentCall(subagentId, ownerThreadId)
      return { call, activity: this.recordSubagentActivityForCall(call) }
    })()
  }

  listSubagentCallsForRuns(
    ownerThreadId: string,
    parentRunIds: readonly string[]
  ): AgentSubagentCallRecord[] {
    const selectedRunIds = new Set(parentRunIds)
    if (selectedRunIds.size === 0) return []
    const calls = this.listSubagentCalls(ownerThreadId)
    const selectedCallIds = new Set(
      calls.filter((call) => selectedRunIds.has(call.parentRunId)).map((call) => call.id)
    )
    let changed = true
    while (changed) {
      changed = false
      for (const call of calls) {
        if (
          call.parentSubagentId
          && selectedCallIds.has(call.parentSubagentId)
          && !selectedCallIds.has(call.id)
        ) {
          selectedCallIds.add(call.id)
          changed = true
        }
      }
    }
    return calls.filter((call) => selectedCallIds.has(call.id))
  }

  listOrphanedSubagentThreadIds(): string[] {
    const rows = this.database.prepare(`
      SELECT hidden.thread_id
      FROM agent_hidden_threads hidden
      LEFT JOIN agent_subagent_calls call ON call.child_thread_id = hidden.thread_id
      WHERE hidden.kind = 'subagent' AND call.id IS NULL
      ORDER BY hidden.thread_id ASC
    `).all() as Array<{ thread_id: string }>
    return rows.map((row) => row.thread_id)
  }

  listOwnedThreadIds(ownerThreadId: string): string[] {
    this.requireThread(ownerThreadId)
    const rows = this.database.prepare(`
      SELECT child_thread_id
      FROM agent_subagent_calls
      WHERE owner_thread_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(ownerThreadId) as Array<{ child_thread_id: string }>
    return [ownerThreadId, ...rows.map((row) => row.child_thread_id)]
  }

  listDescendantSubagentCalls(threadId: string, rootRunIds?: readonly string[]): AgentSubagentCallRecord[] {
    this.requireThread(threadId)
    const runs = rootRunIds ? JSON.stringify(rootRunIds) : null
    const rows = this.database.prepare(`
      WITH RECURSIVE descendants(id, child_thread_id) AS (
        SELECT id, child_thread_id FROM agent_subagent_calls
        WHERE parent_thread_id = ?
          AND (? IS NULL OR parent_run_id IN (SELECT value FROM json_each(?)))
        UNION
        SELECT call.id, call.child_thread_id FROM agent_subagent_calls call
        JOIN descendants ON call.parent_thread_id = descendants.child_thread_id
      )
      SELECT call.* FROM agent_subagent_calls call
      JOIN descendants ON call.id = descendants.id
      ORDER BY call.created_at ASC, call.id ASC
    `).all(threadId, runs, runs) as SubagentCallRow[]
    return rows.map(subagentCallFromRow)
  }

  handoffBackgroundTasksToCleanup(cleanupRunId: string): {
    calls: AgentManagedCallRecord[]
    subagents: AgentSubagentCallRecord[]
  } {
    const run = this.requireRun(cleanupRunId)
    return this.database.transaction(() => {
      const descendants = this.listDescendantSubagentCalls(run.threadId)
      const threadIds = [run.threadId, ...descendants.map((call) => call.childThreadId)]
      const calls = threadIds.flatMap((id) => this.listUnresolvedManagedCallsForThread(id))
      const subagents = [...new Set(descendants.map((call) => call.parentRunId))]
        .flatMap((id) => this.listUnresolvedSubagentCallsForRun(id))
      const now = timestamp()
      const markCall = this.database.prepare('INSERT OR IGNORE INTO agent_managed_call_cleanup VALUES (?, ?, ?)')
      const markSubagent = this.database.prepare('INSERT OR IGNORE INTO agent_subagent_cleanup VALUES (?, ?, ?)')
      for (const call of calls) markCall.run(call.id, cleanupRunId, now)
      for (const call of subagents) markSubagent.run(call.id, cleanupRunId, now)
      this.notifyChanged()
      return { calls, subagents }
    })()
  }

  async deleteSubagentThreads(
    ownerThreadId: string
  ): Promise<Map<string, Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>>> {
    const [, ...childThreadIds] = this.listOwnedThreadIds(ownerThreadId)
    return this.deleteThreadStateAtomically(
      childThreadIds,
      'be deleted with its owning conversation'
    )
  }

  listUnresolvedSubagentCallsForRun(
    parentRunId: string,
    limit?: number
  ): AgentSubagentCallRecord[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('Subagent query limit must be a positive safe integer.')
    }
    const rows = this.database.prepare(`
      SELECT call.id, call.owner_thread_id, call.parent_thread_id, call.parent_run_id,
             call.parent_subagent_id, call.child_thread_id, call.child_run_id,
             call.agent_name, call.config_json, call.description,
             call.status, call.result_text, call.error,
             call.created_at, call.updated_at
      FROM agent_subagent_calls call
      WHERE call.parent_run_id = ?
        AND NOT EXISTS (SELECT 1 FROM agent_subagent_cleanup cleanup WHERE cleanup.subagent_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_subagent_observations observation
          WHERE observation.subagent_id = call.id
            AND observation.observing_run_id = call.parent_run_id
        )
      ORDER BY call.created_at ASC, call.id ASC
      LIMIT ?
    `).all(parentRunId, limit ?? -1) as SubagentCallRow[]
    return rows.map(subagentCallFromRow)
  }

  finishSubagentCall(input: {
    subagentId: string
    ownerThreadId: string
    status: Exclude<AgentSubagentCallStatus, 'running' | 'interrupted'>
    result?: string
    error?: string
  }): AgentSubagentCallTransition | undefined {
    const now = timestamp()
    return this.database.transaction(() => {
      this.requireSubagentCall(input.subagentId, input.ownerThreadId)
      const updated = this.database.prepare(`
        UPDATE agent_subagent_calls
        SET status = @status,
            result_text = @result,
            error = @error,
            updated_at = @updatedAt
        WHERE id = @id
          AND owner_thread_id = @ownerThreadId
          AND status IN ('running', 'interrupted')
      `).run({
        id: input.subagentId,
        ownerThreadId: input.ownerThreadId,
        status: input.status,
        result: input.status === 'completed' ? input.result ?? null : null,
        error: input.status === 'failed' ? input.error ?? null : null,
        updatedAt: now
      })
      if (updated.changes === 0) return undefined
      const call = this.requireSubagentCall(input.subagentId, input.ownerThreadId)
      const activity = this.recordSubagentActivityForCall(call)
      this.settleProjectedActivitiesForSubagent(call.id, activity.completedAt ?? now)
      return { call, activity }
    })()
  }

  markSubagentCallInterrupted(
    subagentId: string,
    ownerThreadId: string
  ): AgentSubagentCallTransition | undefined {
    return this.database.transaction(() => {
      this.requireSubagentCall(subagentId, ownerThreadId)
      const updated = this.database.prepare(`
        UPDATE agent_subagent_calls
        SET status = 'interrupted', error = NULL, updated_at = ?
        WHERE id = ? AND owner_thread_id = ? AND status = 'running'
      `).run(timestamp(), subagentId, ownerThreadId)
      if (updated.changes === 0) return undefined
      const call = this.requireSubagentCall(subagentId, ownerThreadId)
      return { call, activity: this.recordSubagentActivityForCall(call) }
    })()
  }

  markSubagentCallRunning(
    subagentId: string,
    ownerThreadId: string
  ): AgentSubagentCallTransition | undefined {
    return this.database.transaction(() => {
      this.requireSubagentCall(subagentId, ownerThreadId)
      const updated = this.database.prepare(`
        UPDATE agent_subagent_calls
        SET status = 'running', error = NULL, updated_at = ?
        WHERE id = ?
          AND owner_thread_id = ?
          AND (
            status = 'interrupted'
            OR (status = 'running' AND error IS NOT NULL)
          )
      `).run(timestamp(), subagentId, ownerThreadId)
      if (updated.changes === 0) return undefined
      const call = this.requireSubagentCall(subagentId, ownerThreadId)
      return { call, activity: this.recordSubagentActivityForCall(call) }
    })()
  }

  recordSubagentRecoveryFailure(
    subagentId: string,
    ownerThreadId: string,
    error: string
  ): AgentSubagentCallTransition | undefined {
    requireNonEmptyText(error, 'Subagent recovery error')
    return this.database.transaction(() => {
      this.requireSubagentCall(subagentId, ownerThreadId)
      const updated = this.database.prepare(`
        UPDATE agent_subagent_calls
        SET error = ?, updated_at = ?
        WHERE id = ?
          AND owner_thread_id = ?
          AND status IN ('running', 'interrupted')
          AND error IS NOT ?
      `).run(error, timestamp(), subagentId, ownerThreadId, error)
      if (updated.changes === 0) return undefined
      const call = this.requireSubagentCall(subagentId, ownerThreadId)
      return { call, activity: this.recordSubagentActivityForCall(call) }
    })()
  }

  resolveSubagentCall(
    subagentId: string,
    ownerThreadId: string,
    observingRunId: string
  ): AgentSubagentCallRecord {
    const call = this.requireSubagentCall(subagentId, ownerThreadId)
    if (call.status === 'running' || call.status === 'interrupted') {
      throw new Error(`Subagent ${subagentId} is still ${call.status}.`)
    }
    const observingRun = this.requireRun(observingRunId)
    if (observingRun.id !== call.parentRunId) {
      throw new Error(`Run ${observingRunId} does not own subagent ${subagentId}.`)
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_subagent_observations (
        subagent_id, observing_run_id, observed_at
      ) VALUES (?, ?, ?)
    `).run(subagentId, observingRunId, timestamp())
    return call
  }

  private requireSubagentCall(
    subagentId: string,
    ownerThreadId: string
  ): AgentSubagentCallRecord {
    const call = this.getSubagentCall(subagentId, ownerThreadId)
    if (!call) throw new Error(`Subagent ${subagentId} was not found.`)
    return call
  }

  createManagedCall(input: {
    id: string
    threadId: string
    runId: string
    kind: AgentManagedCallKind
    summary: string
  }): AgentManagedCallRecord {
    const run = this.requireRun(input.runId)
    if (run.threadId !== input.threadId) {
      throw new Error(`Run ${input.runId} does not belong to thread ${input.threadId}.`)
    }
    const now = timestamp()
    this.database.prepare(`
      INSERT INTO agent_managed_calls (
        id, thread_id, run_id, kind, summary, status,
        result_text, outcome_json, error, output_chars,
        progress_current, progress_total, progress_unit,
        next_output_sequence, dispatched_at, detached_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'preparing', NULL, NULL, NULL, 0, NULL, NULL, NULL, 1, NULL, NULL, ?, ?)
    `).run(input.id, input.threadId, input.runId, input.kind, input.summary, now, now)
    return this.requireManagedCall(input.id, input.threadId)
  }

  getManagedCall(callId: string, threadId: string): AgentManagedCallRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, thread_id, run_id, kind, summary, status,
             result_text, outcome_json, error, output_chars,
             progress_current, progress_total, progress_unit, dispatched_at,
             detached_at, created_at, updated_at
      FROM agent_managed_calls
      WHERE id = ? AND thread_id = ?
    `).get(callId, threadId) as ManagedCallRow | undefined
    return row ? managedCallFromRow(row) : undefined
  }

  listUnresolvedManagedCalls(runId: string): AgentManagedCallRecord[] {
    const rows = this.database.prepare(`
      SELECT id, thread_id, run_id, kind, summary, status,
             result_text, outcome_json, error, output_chars,
             progress_current, progress_total, progress_unit, dispatched_at,
             detached_at, created_at, updated_at
      FROM agent_managed_calls AS call
      WHERE call.run_id = ?
        AND call.detached_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_managed_call_cleanup cleanup WHERE cleanup.call_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_managed_call_observations AS observation
          WHERE observation.call_id = call.id
        )
      ORDER BY call.created_at ASC, call.id ASC
    `).all(runId) as ManagedCallRow[]
    return rows.map(managedCallFromRow)
  }

  listUnresolvedManagedCallsForThread(
    threadId: string,
    limit?: number
  ): AgentManagedCallRecord[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('Managed call query limit must be a positive safe integer.')
    }
    const rows = this.database.prepare(`
      SELECT id, thread_id, run_id, kind, summary, status,
             result_text, outcome_json, error, output_chars,
             progress_current, progress_total, progress_unit, dispatched_at,
             detached_at, created_at, updated_at
      FROM agent_managed_calls AS call
      WHERE call.thread_id = ?
        AND call.detached_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_managed_call_cleanup cleanup WHERE cleanup.call_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_managed_call_observations AS observation
          WHERE observation.call_id = call.id
        )
      ORDER BY call.created_at ASC, call.id ASC
      LIMIT ?
    `).all(threadId, limit ?? -1) as ManagedCallRow[]
    return rows.map(managedCallFromRow)
  }

  hasUnresolvedManagedCallsForThread(threadId: string): boolean {
    return this.database.prepare(`
      SELECT 1
      FROM agent_managed_calls AS call
      WHERE call.thread_id = ?
        AND call.detached_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_managed_call_cleanup cleanup WHERE cleanup.call_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_managed_call_observations AS observation
          WHERE observation.call_id = call.id
        )
      LIMIT 1
    `).get(threadId) !== undefined
  }

  listThreadIdsWithUnresolvedManagedCalls(): string[] {
    const rows = this.database.prepare(`
      SELECT DISTINCT call.thread_id
      FROM agent_managed_calls AS call
      WHERE call.detached_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_managed_call_cleanup cleanup WHERE cleanup.call_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_managed_call_observations AS observation
          WHERE observation.call_id = call.id
        )
      ORDER BY call.thread_id ASC
    `).all() as Array<{ thread_id: string }>
    return rows.map((row) => row.thread_id)
  }

  markManagedCallDetached(callId: string, threadId: string): AgentManagedCallRecord {
    const call = this.requireManagedCall(callId, threadId)
    if (!call.detachedAt) {
      const now = timestamp()
      this.database.prepare(`
        UPDATE agent_managed_calls
        SET detached_at = ?, updated_at = ?
        WHERE id = ? AND thread_id = ? AND detached_at IS NULL
      `).run(now, now, callId, threadId)
    }
    return this.requireManagedCall(callId, threadId)
  }

  resolveManagedCall(
    callId: string,
    threadId: string,
    observingRunId: string
  ): AgentManagedCallRecord {
    const call = this.requireManagedCall(callId, threadId)
    if (!isTerminalManagedCallStatus(call.status)) {
      throw new Error(`Managed call ${callId} is still ${call.status}.`)
    }
    if (!call.detachedAt) {
      throw new Error(`Managed call ${callId} has not returned a background handle.`)
    }
    const observingRun = this.requireRun(observingRunId)
    if (observingRun.threadId !== threadId) {
      throw new Error(`Run ${observingRunId} does not belong to thread ${threadId}.`)
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_managed_call_observations (
        call_id, thread_id, run_id, observed_at
      ) VALUES (?, ?, ?, ?)
    `).run(callId, threadId, observingRunId, timestamp())
    return call
  }

  markManagedCallRunning(callId: string, threadId: string): AgentManagedCallRecord {
    const now = timestamp()
    const changed = this.database.prepare(`
      UPDATE agent_managed_calls
      SET status = 'running', dispatched_at = ?, updated_at = ?
      WHERE id = ? AND thread_id = ? AND status = 'preparing'
    `).run(now, now, callId, threadId)
    if (changed.changes !== 1) {
      const call = this.getManagedCall(callId, threadId)
      if (!call) throw new Error(`Managed call ${callId} was not found.`)
      if (call.status !== 'running') throw new Error(`Managed call ${callId} is already ${call.status}.`)
      return call
    }
    return this.requireManagedCall(callId, threadId)
  }

  appendManagedCallOutput(input: {
    callId: string
    threadId: string
    stream: AgentManagedCallOutputChunk['stream']
    text: string
  }): AgentManagedCallOutputChunk | undefined {
    return this.appendManagedCallOutputBatch({
      callId: input.callId,
      threadId: input.threadId,
      chunks: [{ stream: input.stream, text: input.text }]
    })[0]
  }

  appendManagedCallOutputBatch(input: {
    callId: string
    threadId: string
    chunks: ReadonlyArray<Pick<AgentManagedCallOutputChunk, 'stream' | 'text'>>
  }): AgentManagedCallOutputChunk[] {
    const chunks = input.chunks.filter((chunk) => chunk.text.length > 0)
    if (chunks.length === 0) return []
    const append = this.database.transaction(() => {
      const state = this.database.prepare(`
        SELECT status, output_chars, next_output_sequence
        FROM agent_managed_calls
        WHERE id = ? AND thread_id = ?
      `).get(input.callId, input.threadId) as ManagedCallOutputStateRow | undefined
      if (!state) throw new Error(`Managed call ${input.callId} was not found.`)
      if (state.status !== 'preparing' && state.status !== 'running') return []

      const insert = this.database.prepare(`
        INSERT INTO agent_managed_call_output (
          call_id, sequence, stream, start_offset, end_offset, text
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      const stored: AgentManagedCallOutputChunk[] = []
      let outputChars = state.output_chars
      let nextSequence = state.next_output_sequence
      for (const chunk of chunks) {
        const startOffset = outputChars
        const endOffset = startOffset + chunk.text.length
        insert.run(
          input.callId,
          nextSequence,
          chunk.stream,
          startOffset,
          endOffset,
          chunk.text
        )
        stored.push({
          sequence: nextSequence,
          stream: chunk.stream,
          startOffset,
          endOffset,
          text: chunk.text
        })
        outputChars = endOffset
        nextSequence += 1
      }
      this.database.prepare(`
        UPDATE agent_managed_calls
        SET output_chars = ?,
            next_output_sequence = ?,
            updated_at = ?
        WHERE id = ? AND thread_id = ?
      `).run(
        outputChars,
        nextSequence,
        timestamp(),
        input.callId,
        input.threadId
      )
      return stored
    })
    return append()
  }

  readManagedCallOutputRange(
    callId: string,
    threadId: string,
    requestedOffset: number,
    length: number
  ): {
    chunks: AgentManagedCallOutputChunk[]
    startOffset: number
    endOffset: number
    totalChars: number
    hasBefore: boolean
    hasAfter: boolean
  } {
    const call = this.requireManagedCall(callId, threadId)
    const startOffset = requestedOffset < 0
      ? Math.max(0, call.outputChars + requestedOffset)
      : Math.min(call.outputChars, requestedOffset)
    const endOffset = Math.min(call.outputChars, startOffset + length)
    const rows = this.database.prepare(`
      SELECT sequence, stream, start_offset, end_offset, text
      FROM agent_managed_call_output
      WHERE call_id = ?
        AND end_offset > ?
        AND start_offset < ?
      ORDER BY sequence ASC
    `).all(callId, startOffset, endOffset) as ManagedCallOutputRow[]
    const chunks = rows.map((row) => {
      const chunkStart = Math.max(startOffset, row.start_offset)
      const chunkEnd = Math.min(endOffset, row.end_offset)
      return {
        sequence: row.sequence,
        stream: row.stream,
        startOffset: chunkStart,
        endOffset: chunkEnd,
        text: row.text.slice(chunkStart - row.start_offset, chunkEnd - row.start_offset)
      }
    })
    return {
      chunks,
      startOffset,
      endOffset,
      totalChars: call.outputChars,
      hasBefore: startOffset > 0,
      hasAfter: endOffset < call.outputChars
    }
  }

  updateManagedCallProgress(input: {
    callId: string
    threadId: string
    current: number
    total?: number
    unit: string
  }): AgentManagedCallRecord {
    if (!Number.isFinite(input.current) || input.current < 0) {
      throw new Error('Managed call progress must be a non-negative finite number.')
    }
    if (input.total !== undefined && (!Number.isFinite(input.total) || input.total < 0)) {
      throw new Error('Managed call progress total must be a non-negative finite number.')
    }
    const changed = this.database.prepare(`
      UPDATE agent_managed_calls
      SET progress_current = ?, progress_total = ?, progress_unit = ?, updated_at = ?
      WHERE id = ? AND thread_id = ? AND status IN ('preparing', 'running')
    `).run(
      input.current,
      input.total ?? null,
      input.unit,
      timestamp(),
      input.callId,
      input.threadId
    )
    if (changed.changes !== 1) return this.requireManagedCall(input.callId, input.threadId)
    return this.requireManagedCall(input.callId, input.threadId)
  }

  finishManagedCall(input: {
    callId: string
    threadId: string
    status: Exclude<AgentManagedCallStatus, 'preparing' | 'running'>
    result?: string
    outcome?: Record<string, unknown>
    error?: string
  }): AgentManagedCallRecord {
    return this.database.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE agent_managed_calls
        SET status = @status,
            result_text = @result,
            outcome_json = @outcome,
            error = @error,
            updated_at = @updatedAt
        WHERE id = @id
          AND thread_id = @threadId
          AND status IN ('preparing', 'running')
      `).run({
        id: input.callId,
        threadId: input.threadId,
        status: input.status,
        result: input.result ?? null,
        outcome: serializeValue(input.outcome),
        error: input.error ?? null,
        updatedAt: timestamp()
      })
      const call = this.getManagedCall(input.callId, input.threadId)
      if (!call) throw new Error(`Managed call ${input.callId} was not found.`)
      if (changed.changes !== 1 && (call.status === 'preparing' || call.status === 'running')) {
        throw new Error(`Managed call ${input.callId} could not be completed.`)
      }
      if (changed.changes === 1 && call.result && call.outcome?.result_format === 'langchain') {
        const reference: unknown = JSON.parse(call.result)
        if (!isManagedToolResultReference(reference) || reference.thread_id !== call.threadId) {
          throw new Error('Invalid persisted managed tool result reference.')
        }
        this.database.prepare(`INSERT INTO message_references(thread_id,checkpoint_ns,owner_kind,owner_key,record_id)
          VALUES (?,'','activity',?,?)`).run(call.threadId, `managed-call:${call.id}`, reference.record_id)
      }
      return call
    })()
  }

  deleteManagedCall(callId: string, threadId: string): boolean {
    return this.database.prepare(`
      DELETE FROM agent_managed_calls
      WHERE id = ? AND thread_id = ?
        AND status IN ('completed', 'failed', 'cancelled', 'uncertain')
    `).run(callId, threadId).changes === 1
  }

  close(): void {
    this.closed = true
    this.ownMemoryDatabase?.close()
    this.database.close()
  }

  compact(): void {
    this.database.exec('VACUUM')
    this.database.pragma('wal_checkpoint(TRUNCATE)')
  }

  listThreads(): AgentThread[] {
    const rows = this.database.prepare(`
      SELECT thread.id, thread.title, thread.project_id,
        thread.model_config_id, thread.model_parameter_preset_id, thread.pinned, thread.full_access,
        thread.strict_approval,
        thread.status, thread.created_at, thread.updated_at,
        (
          SELECT COUNT(*)
          FROM agent_runs run
          WHERE run.thread_id = thread.id AND run.operation = 'agent'
        ) AS user_turn_count
      FROM agent_threads thread
      WHERE NOT EXISTS (
        SELECT 1
        FROM agent_hidden_threads hidden
        WHERE hidden.thread_id = thread.id
      )
      ORDER BY pinned DESC, updated_at DESC
    `).all() as ThreadRow[]
    return rows.map(threadFromRow)
  }

  listProjectThreads(projectId: string): AgentThread[] {
    requireNonEmptyText(projectId, 'Project ID')
    const rows = this.database.prepare(`
      SELECT thread.id, thread.title, thread.project_id,
        thread.model_config_id, thread.model_parameter_preset_id, thread.pinned, thread.full_access,
        thread.strict_approval,
        thread.status, thread.created_at, thread.updated_at,
        (
          SELECT COUNT(*)
          FROM agent_runs run
          WHERE run.thread_id = thread.id AND run.operation = 'agent'
        ) AS user_turn_count
      FROM agent_threads thread
      WHERE thread.project_id = ?
      ORDER BY thread.updated_at DESC, thread.id ASC
    `).all(projectId) as ThreadRow[]
    return rows.map(threadFromRow)
  }

  getThread(threadId: string): AgentThread | null {
    const row = this.database.prepare(`
      SELECT thread.id, thread.title, thread.project_id,
        thread.model_config_id, thread.model_parameter_preset_id, thread.pinned, thread.full_access,
        thread.strict_approval,
        thread.status, thread.created_at, thread.updated_at,
        (
          SELECT COUNT(*)
          FROM agent_runs run
          WHERE run.thread_id = thread.id AND run.operation = 'agent'
        ) AS user_turn_count
      FROM agent_threads thread
      WHERE thread.id = ?
    `).get(threadId) as ThreadRow | undefined
    return row ? threadFromRow(row) : null
  }

  createThread(
    options: AgentThreadCreate = {},
    threadId: string = randomUUID()
  ): AgentThread {
    this.notifyChanged()
    const now = timestamp()
    const thread: AgentThread = {
      id: threadId,
      title: defaultTitle(options.title),
      projectId: options.projectId ?? DEFAULT_WORKSPACE_PROJECT_ID,
      modelConfigId: options.modelConfigId,
      modelParameterPresetId: options.modelParameterPresetId ?? undefined,
      pinned: false,
      accessMode: options.accessMode ?? 'read_only_allowed',
      status: 'idle',
      userTurnCount: 0,
      createdAt: now,
      updatedAt: now
    }
    const create = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO agent_threads (
          id, title, project_id, model_config_id, model_parameter_preset_id,
          pinned, full_access, strict_approval,
          status, created_at, updated_at
        ) VALUES (
          @id, @title, @projectId, @modelConfigId, @modelParameterPresetId,
          0, @fullAccess, @strictApproval,
          @status, @createdAt, @updatedAt
        )
      `).run({
        ...thread,
        modelConfigId: thread.modelConfigId ?? null,
        modelParameterPresetId: thread.modelParameterPresetId ?? null,
        ...accessModeColumns(thread.accessMode)
      })
    })
    create()
    return thread
  }

  updateThread(
    threadId: string,
    update: AgentThreadUpdate & { status?: AgentThreadStatus }
  ): AgentThread {
    this.notifyChanged()
    const existing = this.requireThread(threadId)
    if (update.modelConfigId === null && !this.getSubagentCallByChildThreadId(threadId)) {
      throw new Error('A root conversation must select its own model.')
    }
    if (update.modelConfigId === null && update.modelParameterPresetId) {
      throw new Error('An inherited model selection also inherits its parameter preset.')
    }
    const next: AgentThread = {
      ...existing,
      title: update.title === undefined ? existing.title : defaultTitle(update.title),
      projectId: update.projectId ?? existing.projectId,
      modelConfigId: update.modelConfigId === undefined ? existing.modelConfigId : update.modelConfigId ?? undefined,
      modelParameterPresetId: update.modelConfigId === null ? undefined : update.modelParameterPresetId === undefined
        ? existing.modelParameterPresetId
        : update.modelParameterPresetId ?? undefined,
      pinned: update.pinned ?? existing.pinned,
      status: update.status ?? existing.status,
      updatedAt: timestamp()
    }
    this.database.prepare(`
      UPDATE agent_threads
      SET title = @title,
          project_id = @projectId,
          model_config_id = @modelConfigId,
          model_parameter_preset_id = @modelParameterPresetId,
          pinned = @pinned,
          full_access = @fullAccess,
          strict_approval = @strictApproval,
          status = @status,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      ...next,
      modelConfigId: next.modelConfigId ?? null,
      modelParameterPresetId: next.modelParameterPresetId ?? null,
      pinned: next.pinned ? 1 : 0,
      ...accessModeColumns(next.accessMode)
    })
    return next
  }

  setAccessMode(threadId: string, accessMode: AgentAccessMode): AgentThread {
    this.notifyChanged()
    this.requireThread(threadId)
    const columns = accessModeColumns(accessMode)
    this.database.prepare(`
      UPDATE agent_threads
      SET full_access = ?, strict_approval = ?, updated_at = ?
      WHERE id = ?
    `).run(columns.fullAccess, columns.strictApproval, timestamp(), threadId)
    return this.requireThread(threadId)
  }

  async deleteThread(
    threadId: string
  ): Promise<Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>> {
    return this.deleteThreadStateAtomically([threadId], 'be deleted').get(threadId) ?? []
  }

  async deleteThreadTree(
    ownerThreadId: string
  ): Promise<Map<string, Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>>> {
    return this.deleteThreadStateAtomically(
      this.listOwnedThreadIds(ownerThreadId),
      'be deleted with its owning conversation'
    )
  }

  deleteThreadMetadata(
    threadIds: string[]
  ): Map<string, Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>> {
    this.notifyChanged()
    if (threadIds.length === 0) return new Map()
    return this.database.transaction(() => {
      const attachments = new Map<
        string,
        Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>
      >()
      for (const threadId of threadIds) {
        this.assertThreadMutable(threadId, 'be deleted')
        attachments.set(threadId, this.attachmentsForThreadDeletion(threadId))
      }
      const remove = this.database.prepare('DELETE FROM agent_threads WHERE id = ?')
      for (const threadId of threadIds) {
        this.enqueueAttachmentCleanup(threadId)
        remove.run(threadId)
      }
      return attachments
    })()
  }

  private deleteThreadStateAtomically(
    threadIds: string[],
    action: string
  ): Map<string, Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>> {
    this.notifyChanged()
    const uniqueThreadIds = [...new Set(threadIds)]
    if (uniqueThreadIds.length === 0) return new Map()
    return this.database.transaction(() => {
      const attachments = new Map<
        string,
        Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>
      >()
      for (const threadId of uniqueThreadIds) {
        this.assertThreadMutable(threadId, action)
        attachments.set(threadId, this.attachmentsForThreadDeletion(threadId))
      }

      const removeThread = this.database.prepare('DELETE FROM agent_threads WHERE id = ?')
      for (const threadId of uniqueThreadIds) {
        this.checkpointer.deleteThreadSync(threadId)
        this.enqueueAttachmentCleanup(threadId)
      }
      // Delete child threads before their owner. This keeps subagent foreign-key
      // cascades local to each child and avoids depending on call-row ordering.
      for (const threadId of [...uniqueThreadIds].reverse()) removeThread.run(threadId)
      return attachments
    })()
  }

  listUnpinnedThreadsForCleanup(): AgentThread[] {
    return this.listThreads().filter((thread) => !thread.pinned)
  }

  assertThreadMutable(threadId: string, action: string): AgentThread {
    const thread = this.requireThread(threadId)
    if (isAgentThreadLocked(thread.status)) {
      throw new AgentThreadLockedError(threadId, action)
    }
    return thread
  }

  createRun(
    threadId: string,
    runId: string = randomUUID(),
    operation: AgentRun['operation'] = 'agent',
    attachments: ArchivedAgentAttachment[] = [],
    inputIntent?: AgentRunInputIntent,
    submissionId?: string
  ): AgentRun {
    this.notifyChanged()
    const now = timestamp()
    const run: AgentRun = {
      id: runId,
      threadId,
      operation,
      status: 'running',
      createdAt: now,
      updatedAt: now
    }
    const create = this.database.transaction((): AgentRun => {
      this.assertThreadMutable(threadId, 'start another run')
      this.database.prepare(`
        INSERT INTO agent_runs (id, submission_id, thread_id, operation, status, created_at, updated_at)
        VALUES (@id, @submissionId, @threadId, @operation, @status, @createdAt, @updatedAt)
      `).run({ ...run, submissionId: submissionId ?? null })
      this.database.prepare(`
        UPDATE agent_threads
        SET status = 'running', updated_at = ?
        WHERE id = ?
      `).run(now, threadId)
      if (inputIntent) {
        this.database.prepare(`
          INSERT INTO agent_run_input_intents (run_id, input_json)
          VALUES (?, ?)
        `).run(run.id, serializeRunInputIntent(inputIntent))
      }
      if (attachments.some(({ artifact }) => artifact.messageId !== `${runId}:input`)) {
        throw new Error(`Initial attachments do not belong to run input ${runId}.`)
      }
      this.insertArchivedAttachments(run, attachments)
      return run
    })
    return create()
  }

  appendRunAttachments(runId: string, attachments: ArchivedAgentAttachment[]): void {
    if (attachments.length === 0) return
    const append = this.database.transaction(() => {
      const run = this.requireRun(runId)
      if (run.status !== 'running') {
        throw new Error(`Run ${runId} is not accepting attachments.`)
      }
      this.insertArchivedAttachments(run, attachments)
    })
    append()
  }

  private insertArchivedAttachments(
    run: AgentRun,
    attachments: ArchivedAgentAttachment[]
  ): void {
    const insertAttachment = this.database.prepare(`
      INSERT INTO agent_attachments (
        id,
        thread_id,
        message_id,
        run_id,
        name,
        mime_type,
        size,
        kind,
        storage_path,
        text_truncated,
        context_policy,
        created_at
      ) VALUES (
        @id,
        @threadId,
        @messageId,
        @runId,
        @name,
        @mimeType,
        @size,
        @kind,
        @storagePath,
        @textTruncated,
        @contextPolicy,
        @createdAt
      )
    `)
    for (const archived of attachments) {
      const artifact = archived.artifact
      if (
        artifact.threadId !== run.threadId
        || artifact.runId !== run.id
        || !artifact.messageId.startsWith(`${run.id}:`)
      ) {
        throw new Error(`Attachment ${artifact.id} does not belong to run ${run.id}.`)
      }
      insertAttachment.run({
        ...artifact,
        storagePath: archived.storagePath,
        textTruncated: artifact.textTruncated ? 1 : 0
      })
    }
  }

  createThreadAndRun(
    threadId: string,
    threadOptions: AgentThreadCreate,
    runId: string,
    attachments: ArchivedAgentAttachment[],
    inputIntent: AgentRunInputIntent,
    submissionId: string
  ): { thread: AgentThread; run: AgentRun } {
    return this.database.transaction(() => {
      this.createThread(threadOptions, threadId)
      const run = this.createRun(
        threadId,
        runId,
        'agent',
        attachments,
        inputIntent,
        submissionId
      )
      const thread = this.getThread(threadId)
      if (!thread) throw new Error(`Thread ${threadId} was not created.`)
      return { thread, run }
    })()
  }

  getRun(runId: string): AgentRun | null {
    const row = this.database.prepare(`
      SELECT id, thread_id, operation, status, created_at, updated_at, error
      FROM agent_runs
      WHERE id = ?
    `).get(runId) as RunRow | undefined
    return row ? runFromRow(row, this.readBackgroundCleanup(row.id)) : null
  }

  getRunConfiguration(runId: string): RunConfiguration | undefined {
    const row = this.database.prepare(`
      SELECT configuration_json FROM agent_runs WHERE id = ?
    `).get(runId) as { configuration_json: string | null } | undefined
    if (!row) throw new Error(`Run ${runId} was not found.`)
    return row.configuration_json === null ? undefined : parseRunConfiguration(JSON.parse(row.configuration_json))
  }

  resolveRunConfiguration(runId: string, value: RunConfiguration): void {
    const serialized = JSON.stringify(serializeRunConfiguration(value))
    // Capture the first resolved configuration before graph execution. Approval
    // continuations and process recovery must keep the same run-level setting.
    const row = this.database.prepare(`
      UPDATE agent_runs
      SET configuration_json = COALESCE(configuration_json, @serialized)
      WHERE id = @runId
      RETURNING configuration_json
    `).get({ runId, serialized }) as { configuration_json: string } | undefined
    if (!row) throw new Error(`Run ${runId} was not found.`)
    if (row.configuration_json !== serialized) {
      throw new Error(`The configuration for run ${runId} is already fixed.`)
    }
  }

  getRunBySubmissionId(submissionId: string): AgentRun | null {
    const row = this.database.prepare(`
      SELECT id, thread_id, operation, status, created_at, updated_at, error
      FROM agent_runs
      WHERE submission_id = ?
    `).get(submissionId) as RunRow | undefined
    return row ? runFromRow(row, this.readBackgroundCleanup(row.id)) : null
  }

  getRunCheckpointState(runId: string): AgentRunCheckpointState {
    const row = this.database.prepare(`
      SELECT
        id,
        last_checkpoint_id,
        terminal_checkpoint_id,
        last_write_checkpoint_ns,
        last_write_checkpoint_id,
        cancellation_requested
      FROM agent_runs
      WHERE id = ?
    `).get(runId) as RunCheckpointRow | undefined
    if (!row) throw new Error(`Run ${runId} was not found.`)
    return {
      runId: row.id,
      lastCommittedCheckpointId: row.last_checkpoint_id ?? undefined,
      terminalCheckpointId: row.terminal_checkpoint_id ?? undefined,
      lastWriteCheckpointNamespace: row.last_write_checkpoint_ns ?? undefined,
      lastWriteCheckpointId: row.last_write_checkpoint_id ?? undefined,
      resumeIntent: this.getRunResumeIntent(runId),
      cancellationRequested: row.cancellation_requested === 1
    }
  }

  getRunResumeIntent(runId: string): AgentRunResumeIntent | undefined {
    const rows = this.database.prepare(`
      SELECT interrupt_id, response_json
      FROM agent_run_resume_intents
      WHERE run_id = ?
      ORDER BY rowid ASC
    `).all(runId) as Array<{
      interrupt_id: string
      response_json: string
    }>
    if (rows.length === 0) return undefined
    return Object.fromEntries(rows.map((row) => [
      row.interrupt_id,
      JSON.parse(row.response_json) as unknown
    ]))
  }

  getRunInputIntent(runId: string): AgentRunInputIntent | undefined {
    this.requireRun(runId)
    const row = this.database.prepare(`
      SELECT input_json
      FROM agent_run_input_intents
      WHERE run_id = ?
    `).get(runId) as { input_json: string } | undefined
    return row ? parseRunInputIntent(row.input_json) : undefined
  }

  prepareToolEffect(input: AgentToolEffectPreparation): AgentToolEffectRow {
    validateToolEffectKey(input)
    requireNonEmptyText(input.threadId, 'Tool effect thread ID')
    if (typeof input.writeCheckpointNs !== 'string') {
      throw new Error('Tool effect write checkpoint namespace must be a string.')
    }
    validateNonNegativeInteger(input.callIndex, 'Tool effect call index')
    if (input.toolCallId !== undefined) {
      requireNonEmptyText(input.toolCallId, 'Tool effect tool-call ID')
    }
    requireNonEmptyText(input.toolName, 'Tool effect tool name')
    validateNormalizedJson(input.argsJson, 'Tool effect arguments')
    validateRecoveryMode(input.recoveryMode)

    return this.database.transaction((): AgentToolEffectRow => {
      const run = this.requireRun(input.runId)
      if (run.threadId !== input.threadId) {
        throw new Error(
          `Run ${input.runId} belongs to thread ${run.threadId}, not ${input.threadId}.`
        )
      }
      if (run.status !== 'running') {
        throw new Error(`Run ${input.runId} is not running.`)
      }

      const existing = this.selectToolEffectRow(input)
      if (existing) {
        const mismatches = [
          existing.thread_id === input.threadId ? undefined : 'threadId',
          existing.write_checkpoint_ns === input.writeCheckpointNs
            ? undefined
            : 'writeCheckpointNs',
          existing.call_index === input.callIndex ? undefined : 'callIndex',
          (existing.tool_call_id ?? undefined) === input.toolCallId ? undefined : 'toolCallId',
          existing.tool_name === input.toolName ? undefined : 'toolName',
          existing.args_json === input.argsJson ? undefined : 'argsJson'
        ].filter((field): field is string => field !== undefined)
        if (mismatches.length > 0) {
          throw new Error(
            `Tool effect ${input.callKey} changed immutable fields: ${mismatches.join(', ')}.`
          )
        }
        // Before the first real effect boundary, the current tool metadata is
        // authoritative. Configuration and MCP annotations may legitimately
        // change while a prepared task is being recovered. Once an attempt has
        // been armed, armToolEffect persists and strictly verifies the resolved
        // recovery mode together with the concrete target descriptor.
        if (
          existing.state === 'prepared'
          && existing.effect_attempt === 0
          && existing.recovery_mode !== input.recoveryMode
        ) {
          const updated = this.database.prepare(`
            UPDATE agent_effect_journal
            SET recovery_mode = @recoveryMode
            WHERE run_id = @runId
              AND checkpoint_id = @checkpointId
              AND checkpoint_ns = @checkpointNs
              AND task_id = @taskId
              AND call_key = @callKey
              AND input_hash = @inputHash
              AND state = 'prepared'
              AND effect_attempt = 0
          `).run(input)
          if (updated.changes !== 1) {
            throw new Error(`Tool effect ${input.callKey} changed while it was being prepared.`)
          }
          return toolEffectFromRow(this.requireToolEffectRow(input))
        }
        return toolEffectFromRow(existing)
      }

      this.database.prepare(`
        INSERT INTO agent_effect_journal (
          run_id,
          checkpoint_id,
          checkpoint_ns,
          write_checkpoint_ns,
          task_id,
          call_key,
          input_hash,
          call_index,
          tool_call_id,
          tool_name,
          args_json,
          recovery_mode,
          state
        ) VALUES (
          @runId,
          @checkpointId,
          @checkpointNs,
          @writeCheckpointNs,
          @taskId,
          @callKey,
          @inputHash,
          @callIndex,
          @toolCallId,
          @toolName,
          @argsJson,
          @recoveryMode,
          'prepared'
        )
      `).run({
        ...input,
        toolCallId: input.toolCallId ?? null
      })
      return toolEffectFromRow(this.requireToolEffectRow(input))
    })()
  }

  loadToolEffect(key: AgentToolEffectKey): AgentToolEffectRow | undefined {
    validateToolEffectKey(key)
    const row = this.selectToolEffectRow(key)
    return row ? toolEffectFromRow(row) : undefined
  }

  discardPreparedToolEffect(key: AgentToolEffectKey): boolean {
    validateToolEffectKey(key)
    return this.database.transaction((): boolean => {
      const existing = this.selectToolEffectRow(key)
      if (!existing) return false
      this.assertToolEffectRunIsRunning(existing)
      if (existing.state !== 'prepared' || existing.effect_attempt !== 0) {
        throw new Error(
          `Tool effect ${key.callKey} cannot be discarded after its effect boundary.`
        )
      }
      const result = this.database.prepare(`
        DELETE FROM agent_effect_journal
        WHERE run_id = @runId
          AND checkpoint_id = @checkpointId
          AND checkpoint_ns = @checkpointNs
          AND task_id = @taskId
          AND call_key = @callKey
          AND input_hash = @inputHash
          AND state = 'prepared'
          AND effect_attempt = 0
      `).run(key)
      if (result.changes !== 1) {
        throw new Error(`Tool effect ${key.callKey} changed while it was being discarded.`)
      }
      return true
    })()
  }

  armToolEffect(
    key: AgentToolEffectKey,
    details: AgentToolEffectArmDetails
  ): AgentToolEffectRow {
    validateToolEffectKey(key)
    requireNonEmptyText(details.effectKind, 'Tool effect kind')
    validateNormalizedJson(details.targetJson, 'Tool effect target')
    if (details.recoveryMode !== undefined) validateRecoveryMode(details.recoveryMode)
    if (details.idempotencyFingerprint !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(details.idempotencyFingerprint)) {
        throw new Error('Tool effect idempotency fingerprint must be a SHA-256 digest.')
      }
    }

    return this.database.transaction((): AgentToolEffectRow => {
      const existing = this.requireToolEffectRow(key)
      const run = this.requireRun(existing.run_id)
      // A queued call can already have handed control back to the model when
      // another tool interrupts it. Only that registered background executor
      // may cross its prepared effect boundary while the run awaits input.
      const backgroundCall = run.status === 'interrupted'
        ? this.getManagedCall(agentToolEffectArtifactId(key, 'managed-call'), existing.thread_id)
        : undefined
      if (!(backgroundCall?.runId === key.runId && backgroundCall.status === 'running' && backgroundCall.detachedAt)) {
        this.assertToolEffectRunIsRunning(existing)
      }
      if (existing.state !== 'prepared') {
        throw new Error(
          `Tool effect ${key.callKey} cannot be armed from ${existing.state} state.`
        )
      }
      const recoveryMode = details.recoveryMode ?? existing.recovery_mode
      if (existing.effect_attempt > 0) {
        const idempotencyFingerprint = details.idempotencyFingerprint ?? null
        if (
          recoveryMode !== existing.recovery_mode
          || details.effectKind !== existing.effect_kind
          || details.targetJson !== existing.target_json
          || idempotencyFingerprint !== existing.idempotency_fingerprint
        ) {
          throw new Error(
            `Tool effect ${key.callKey} resolved to a different effect boundary during retry.`
          )
        }
      }

      const result = this.database.prepare(`
        UPDATE agent_effect_journal
        SET state = 'intent',
            recovery_mode = @recoveryMode,
            effect_attempt = effect_attempt + 1,
            effect_kind = @effectKind,
            target_json = @targetJson,
            idempotency_fingerprint = @idempotencyFingerprint
        WHERE run_id = @runId
          AND checkpoint_id = @checkpointId
          AND checkpoint_ns = @checkpointNs
          AND task_id = @taskId
          AND call_key = @callKey
          AND input_hash = @inputHash
          AND state = 'prepared'
      `).run({
        ...key,
        recoveryMode,
        effectKind: details.effectKind,
        targetJson: details.targetJson,
        idempotencyFingerprint: details.idempotencyFingerprint ?? null
      })
      if (result.changes !== 1) {
        throw new Error(`Tool effect ${key.callKey} changed while it was being armed.`)
      }
      return toolEffectFromRow(this.requireToolEffectRow(key))
    })()
  }

  retryToolEffect(
    key: AgentToolEffectKey,
    retry: AgentToolEffectRetry
  ): AgentToolEffectRow {
    validateToolEffectKey(key)
    if (retry.kind === 'approved') {
      validateNonNegativeInteger(
        retry.expectedConfirmationCount,
        'Expected tool effect confirmation count'
      )
    } else if (retry.kind === 'automatic') {
      validateNonNegativeInteger(
        retry.expectedAutomaticRetryCount,
        'Expected automatic tool effect retry count'
      )
    } else {
      throw new Error('Tool effect retry kind must be approved or automatic.')
    }

    return this.database.transaction((): AgentToolEffectRow => {
      const existing = this.requireToolEffectRow(key)
      this.assertToolEffectRunIsRunning(existing)
      if (existing.state !== 'intent') {
        throw new Error(
          `Tool effect ${key.callKey} cannot be reset for retry from ${existing.state} state.`
        )
      }
      if (retry.kind === 'approved') {
        if (existing.recovery_mode !== 'confirm') {
          throw new Error(`Tool effect ${key.callKey} does not use confirmation recovery.`)
        }
        if (existing.confirmation_count !== retry.expectedConfirmationCount) {
          throw new Error(`Tool effect ${key.callKey} confirmation count changed.`)
        }
        const result = this.database.prepare(`
          UPDATE agent_effect_journal
          SET state = 'prepared',
              confirmation_count = confirmation_count + 1
          WHERE run_id = @runId
            AND checkpoint_id = @checkpointId
            AND checkpoint_ns = @checkpointNs
            AND task_id = @taskId
            AND call_key = @callKey
            AND input_hash = @inputHash
            AND state = 'intent'
            AND recovery_mode = 'confirm'
            AND confirmation_count = @expectedConfirmationCount
        `).run({ ...key, expectedConfirmationCount: retry.expectedConfirmationCount })
        if (result.changes !== 1) {
          throw new Error(`Tool effect ${key.callKey} changed while approval was committed.`)
        }
      } else {
        if (existing.recovery_mode !== 'idempotent') {
          throw new Error(`Tool effect ${key.callKey} does not support automatic recovery.`)
        }
        if (existing.automatic_retry_count !== retry.expectedAutomaticRetryCount) {
          throw new Error(`Tool effect ${key.callKey} automatic retry count changed.`)
        }
        const result = this.database.prepare(`
          UPDATE agent_effect_journal
          SET state = 'prepared',
              automatic_retry_count = automatic_retry_count + 1
          WHERE run_id = @runId
            AND checkpoint_id = @checkpointId
            AND checkpoint_ns = @checkpointNs
            AND task_id = @taskId
            AND call_key = @callKey
            AND input_hash = @inputHash
            AND state = 'intent'
            AND recovery_mode = 'idempotent'
            AND automatic_retry_count = @expectedAutomaticRetryCount
        `).run({
          ...key,
          expectedAutomaticRetryCount: retry.expectedAutomaticRetryCount
        })
        if (result.changes !== 1) {
          throw new Error(`Tool effect ${key.callKey} changed while retry was committed.`)
        }
      }
      return toolEffectFromRow(this.requireToolEffectRow(key))
    })()
  }

  async persistManagedToolResult(threadId: string, runId: string, message: ToolMessage): Promise<string> {
    if (!ToolMessage.isInstance(message)) throw new Error('A managed tool result must be a complete ToolMessage.')
    if (this.requireRun(runId).threadId !== threadId) throw new Error('Managed tool result belongs to another conversation.')
    const ownerKey = `managed:${runId}:${message.id ?? randomUUID()}`
    const encoded = await this.checkpointer.saveReferencedValue(threadId, message, ownerKey, '', () => {
      if (this.requireRun(runId).threadId !== threadId) throw new Error('Managed tool result belongs to another conversation.')
      this.registerMessagePayload(threadId, message)
      this.database.prepare('UPDATE agent_message_payloads SET run_id=? WHERE thread_id=? AND message_id=?')
        .run(runId, threadId, message.id)
      this.database.prepare("DELETE FROM message_references WHERE thread_id=? AND checkpoint_ns='' AND owner_kind='activity' AND owner_key=?")
        .run(threadId, ownerKey)
    })
    return encoded.references[0].records[0]
  }

  async readManagedToolResult(threadId: string, recordId: string): Promise<ToolMessage> {
    this.requireThread(threadId)
    const message = await this.checkpointer.getMessageByRecordId(threadId, recordId)
    if (!message || !ToolMessage.isInstance(message)) throw new Error('The persisted managed tool result is missing or invalid.')
    return message
  }

  readManagedToolResultSync(threadId: string, recordId: string): ToolMessage {
    this.requireThread(threadId)
    const record = this.checkpointer.getMessageRecordById(threadId, recordId)
    const message = record ? this.checkpointer.readMessageRecordSync(record) : undefined
    if (!message || !ToolMessage.isInstance(message)) throw new Error('The persisted managed tool result is missing or invalid.')
    return message
  }

  async storeToolEffectResult(
    key: AgentToolEffectKey,
    input: AgentToolEffectResultInput
  ): Promise<AgentToolEffectRow> {
    validateToolEffectKey(key)
    if (!isToolEffectResult(input.result)) throw new Error('A durable tool effect result must be a ToolMessage or Command.')
    if (input.confirmation !== undefined) {
      if (input.confirmation.kind !== 'rejected') {
        throw new Error('Tool effect result confirmation must be rejected.')
      }
      validateNonNegativeInteger(
        input.confirmation.expectedConfirmationCount,
        'Expected tool effect confirmation count'
      )
    }
    const value = input.result
    const serializable: ToolMessage | SerializedToolEffectCommand = value instanceof Command
      ? { anasToolEffectResult: 'command', command: { graph: value.graph, update: value.update, resume: value.resume, goto: value.goto } }
      : value
    const threadId = this.requireToolEffectRow(key).thread_id
    const ownerKey = `effect:${JSON.stringify([key.runId, key.checkpointId, key.checkpointNs, key.taskId, key.callKey])}`
    let stored!: AgentToolEffectRow
    await this.checkpointer.saveReferencedValue(threadId, serializable, ownerKey, key.checkpointNs, (encoded) => {
      const resultType = 'message_refs'
      const resultBlob = Buffer.from(JSON.stringify({ ...encoded, value: [...encoded.value] }), 'utf8')
      stored = this.database.transaction((): AgentToolEffectRow => {
        const existing = this.requireToolEffectRow(key)
        this.assertToolEffectRunIsRunning(existing)
        if (existing.state === 'result') {
          const sameResult = existing.result_type === resultType
            && existing.result_blob !== null
            && equalBytes(existing.result_blob, resultBlob)
          const sameConfirmation = input.confirmation === undefined
            || (
              existing.recovery_mode === 'confirm'
              && existing.confirmation_count
                === input.confirmation.expectedConfirmationCount + 1
            )
          if (sameResult && sameConfirmation) return toolEffectFromRow(existing)
          throw new Error(`Tool effect ${key.callKey} already has a different durable result.`)
        }
        if (existing.state !== 'prepared' && existing.state !== 'intent') {
          throw new Error(
            `Tool effect ${key.callKey} cannot store a result from ${existing.state} state.`
          )
        }

        if (input.confirmation) {
          if (existing.recovery_mode !== 'confirm') {
            throw new Error(`Tool effect ${key.callKey} does not use confirmation recovery.`)
          }
          if (existing.confirmation_count !== input.confirmation.expectedConfirmationCount) {
            throw new Error(`Tool effect ${key.callKey} confirmation count changed.`)
          }
          const result = this.database.prepare(`
            UPDATE agent_effect_journal
            SET state = 'result',
                confirmation_count = confirmation_count + 1,
                result_type = @resultType,
                result_blob = @resultBlob
            WHERE run_id = @runId
              AND checkpoint_id = @checkpointId
              AND checkpoint_ns = @checkpointNs
              AND task_id = @taskId
              AND call_key = @callKey
              AND input_hash = @inputHash
              AND state IN ('prepared', 'intent')
              AND recovery_mode = 'confirm'
              AND confirmation_count = @expectedConfirmationCount
          `).run({
            ...key,
            resultType,
            resultBlob,
            expectedConfirmationCount: input.confirmation.expectedConfirmationCount
          })
          if (result.changes !== 1) {
            throw new Error(`Tool effect ${key.callKey} changed while rejection was committed.`)
          }
        } else {
          const result = this.database.prepare(`
            UPDATE agent_effect_journal
            SET state = 'result',
                result_type = @resultType,
                result_blob = @resultBlob
            WHERE run_id = @runId
              AND checkpoint_id = @checkpointId
              AND checkpoint_ns = @checkpointNs
              AND task_id = @taskId
              AND call_key = @callKey
              AND input_hash = @inputHash
              AND state IN ('prepared', 'intent')
          `).run({
            ...key,
            resultType,
            resultBlob
          })
          if (result.changes !== 1) {
            throw new Error(`Tool effect ${key.callKey} changed while its result was committed.`)
          }
        }
        return toolEffectFromRow(this.requireToolEffectRow(key))
      })()
    })
    return stored
  }

  async deserializeToolEffectResult(
    result: AgentToolEffectSerializedResult,
    threadId: string
  ): Promise<AgentToolEffectResult> {
    validateSerializedToolEffectResult(result)
    if (result.resultType !== 'message_refs') throw new Error('Invalid durable tool effect result encoding.')
    const encoded = JSON.parse(Buffer.from(result.resultBlob).toString('utf8')) as Omit<EncodedStateValue, 'value'> & { value: number[] }
    if (typeof encoded.type !== 'string' || !Array.isArray(encoded.value) || !Array.isArray(encoded.references)) {
      throw new Error('Invalid durable tool effect result references.')
    }
    const value = await this.checkpointer.readReferencedValue(threadId, { ...encoded, value: Uint8Array.from(encoded.value) })
    if (ToolMessage.isInstance(value)) return value
    if (isSerializedToolEffectCommand(value)) {
      return new Command(
        value.command as ConstructorParameters<typeof Command>[0]
      )
    }
    throw new Error('The durable tool effect result is not a ToolMessage or Command.')
  }

  async loadToolEffectResult(
    key: AgentToolEffectKey
  ): Promise<AgentToolEffectResult | undefined> {
    const effect = this.loadToolEffect(key)
    if (!effect || effect.state !== 'result') return undefined
    if (effect.resultType === undefined || effect.resultBlob === undefined) {
      throw new Error(`Tool effect ${key.callKey} has an invalid durable result.`)
    }
    return this.deserializeToolEffectResult({
      resultType: effect.resultType,
      resultBlob: effect.resultBlob
    }, effect.threadId)
  }

  private selectToolEffectRow(key: AgentToolEffectKey): ToolEffectJournalRow | undefined {
    const row = this.database.prepare(`
      SELECT journal.*, run.thread_id
      FROM agent_effect_journal journal
      INNER JOIN agent_runs run ON run.id = journal.run_id
      WHERE journal.run_id = @runId
        AND journal.checkpoint_id = @checkpointId
        AND journal.checkpoint_ns = @checkpointNs
        AND journal.task_id = @taskId
        AND journal.call_key = @callKey
    `).get(key) as ToolEffectJournalRow | undefined
    if (row && row.input_hash !== key.inputHash) {
      throw new Error(`Tool effect ${key.callKey} input hash changed.`)
    }
    return row
  }

  private requireToolEffectRow(key: AgentToolEffectKey): ToolEffectJournalRow {
    const row = this.selectToolEffectRow(key)
    if (!row) throw new Error(`Tool effect ${key.callKey} was not prepared.`)
    return row
  }

  private assertToolEffectRunIsRunning(effect: ToolEffectJournalRow): void {
    const run = this.requireRun(effect.run_id)
    if (run.status !== 'running') throw new Error(`Run ${effect.run_id} is not running.`)
  }

  private hasDurableRootInterrupt(runId: string): boolean {
    const row = this.database.prepare(`
      SELECT
        thread_id,
        last_checkpoint_id
      FROM agent_runs
      WHERE id = ?
    `).get(runId) as {
      thread_id: string
      last_checkpoint_id: string | null
    } | undefined
    if (!row) throw new Error(`Run ${runId} was not found.`)
    if (row.last_checkpoint_id === null) return false
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM pending_writes AS interrupt_write
      WHERE interrupt_write.thread_id = ?
        AND interrupt_write.checkpoint_ns = ''
        AND interrupt_write.checkpoint_id = ?
        AND interrupt_write.channel = '__interrupt__'
        AND NOT EXISTS (
          SELECT 1
          FROM pending_writes AS outcome
          WHERE outcome.thread_id = interrupt_write.thread_id
            AND outcome.checkpoint_ns = interrupt_write.checkpoint_ns
            AND outcome.checkpoint_id = interrupt_write.checkpoint_id
            AND outcome.task_id = interrupt_write.task_id
            AND outcome.channel NOT IN ('__interrupt__', '__resume__')
        )
      LIMIT 1
    `).get(row.thread_id, row.last_checkpoint_id))
  }

  private projectRulesFailure(runId: string): string | undefined {
    const row = this.database.prepare(`
      SELECT json_extract(CAST(state.value AS TEXT),'$.fatalError') AS error
      FROM state_channels state JOIN agent_runs run ON run.thread_id=state.thread_id
      WHERE run.id=? AND state.checkpoint_ns='' AND state.channel='anasProjectRules' AND state.type='json'
        AND json_extract(CAST(state.value AS TEXT),'$.runId')=run.id
      UNION ALL
      SELECT json_extract(CAST(write.value AS TEXT),'$.fatalError') AS error
      FROM pending_writes write JOIN agent_runs run ON run.thread_id=write.thread_id
      WHERE run.id=? AND write.checkpoint_ns='' AND write.channel='anasProjectRules' AND write.type='json'
        AND json_extract(CAST(write.value AS TEXT),'$.runId')=run.id
    `).all(runId,runId) as Array<{error:string|null}>
    return row.find(value=>typeof value.error==='string' && value.error.length>0)?.error ?? undefined
  }

  classifyRunningRun(runId: string): AgentRunningRunDurability {
    const row = this.database.prepare(`
      SELECT
        id,
        thread_id,
        status,
        last_checkpoint_id,
        terminal_checkpoint_id,
        last_write_checkpoint_ns,
        last_write_checkpoint_id,
        cancellation_requested
      FROM agent_runs
      WHERE id = ?
    `).get(runId) as (RunCheckpointRow & {
      thread_id: string
      status: AgentRunStatus
    }) | undefined
    if (!row) throw new Error(`Run ${runId} was not found.`)
    if (row.status !== 'running') {
      throw new Error(`Run ${runId} is not running.`)
    }
    const writes = row.last_checkpoint_id === null
      ? []
      : (this.database.prepare(`
          SELECT DISTINCT task_id, channel
          FROM pending_writes
          WHERE thread_id = ?
            AND checkpoint_ns = ''
            AND checkpoint_id = ?
        `).all(row.thread_id, row.last_checkpoint_id) as Array<{
          task_id: string
          channel: string
        }>)
    const errorTasks = new Set(writes.flatMap((entry) =>
      entry.channel === '__error__' ? [entry.task_id] : []
    ))
    const handledErrorTasks = new Set(writes.flatMap((entry) =>
      entry.channel === '__error_source_node__' ? [entry.task_id] : []
    ))
    if (
      row.terminal_checkpoint_id !== null
      && row.terminal_checkpoint_id === row.last_checkpoint_id
    ) return 'terminal'
    if (row.cancellation_requested === 1) return 'cancellation'
    if (this.projectRulesFailure(runId)) return 'error'
    // A fresh graph input supersedes any pending task outcome on the previous
    // run's head. Keep it retryable until LangGraph atomically persists the
    // new root input checkpoint and acknowledges this intent.
    if (this.getRunInputIntent(runId) !== undefined) return 'recoverable'
    // LangGraph writes __error__ and __error_source_node__ for the same task
    // when a node-level error handler must resume from this root superstep.
    // Only an unpaired task error is a stable failure. Pairing must be scoped
    // by task ID so a handled sibling cannot mask a different failed sibling.
    if ([...errorTasks].some((taskId) => !handledErrorTasks.has(taskId))) {
      return 'error'
    }
    if (
      this.getRunResumeIntent(runId) !== undefined
      || row.last_checkpoint_id !== null
      || row.last_write_checkpoint_id !== null
    ) return 'recoverable'
    return 'no_progress'
  }

  listRecoverableRuns(): AgentRun[] {
    const rows = this.database.prepare(`
      SELECT id, thread_id, operation, status, created_at, updated_at, error
      FROM agent_runs
      WHERE status = 'running'
      ORDER BY rowid ASC
    `).all() as RunRow[]
    return rows
      .filter((row) => this.classifyRunningRun(row.id) === 'recoverable')
      .map((row) => runFromRow(row, this.readBackgroundCleanup(row.id)))
  }

  requestRunCancellation(runId: string, armEffect?: () => void): boolean {
    return this.database.transaction(() => {
      const existing = this.requireRun(runId)
      if (existing.status !== 'running') {
        throw new Error(`Run ${runId} is not running.`)
      }
      const checkpoint = this.getRunCheckpointState(runId)
      if (
        checkpoint.terminalCheckpointId
        && checkpoint.terminalCheckpointId === checkpoint.lastCommittedCheckpointId
      ) return false
      armEffect?.()
      const result = this.database.prepare(`
        UPDATE agent_runs
        SET cancellation_requested = 1, updated_at = ?
        WHERE id = ? AND status = 'running'
      `).run(timestamp(), runId)
      return result.changes === 1
    })()
  }

  cancelRecoverableRun(runId: string, armEffect?: () => void): boolean {
    this.notifyChanged()
    const now = timestamp()
    const cancel = this.database.transaction((): boolean => {
      const existing = this.requireRun(runId)
      if (existing.status !== 'running' && existing.status !== 'interrupted') return false
      if (
        existing.status === 'running'
        && this.classifyRunningRun(runId) !== 'recoverable'
      ) return false
      armEffect?.()
      const result = this.database.prepare(`
        UPDATE agent_runs
        SET status = 'cancelled',
            updated_at = @updatedAt,
            error = NULL,
            terminal_checkpoint_id = NULL,
            cancellation_requested = 1
        WHERE id = @id
          AND status IN ('running', 'interrupted')
      `).run({ id: runId, updatedAt: now })
      if (result.changes === 0) return false
      this.database.prepare(`
        DELETE FROM agent_run_resume_intents
        WHERE run_id = ?
      `).run(runId)
      this.database.prepare(`
        DELETE FROM agent_run_input_intents
        WHERE run_id = ?
      `).run(runId)
      this.retainUncommittedFileEdits(runId)
      this.database.prepare(`
        DELETE FROM agent_effect_journal
        WHERE run_id = ?
      `).run(runId)
      this.database.prepare(`
        INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox (run_id)
        VALUES (?)
      `).run(runId)
      this.database.prepare(`
        UPDATE agent_threads
        SET status = 'idle', updated_at = ?
        WHERE id = ?
      `).run(now, existing.threadId)
      this.reconcileCompletedRun(runId)
      return true
    })
    const cancelled = cancel()
    if (cancelled) this.releaseTransientRunActivity(runId)
    return cancelled
  }

  listFileEditCleanupRunIds(): string[] {
    const rows = this.database.prepare(`
      SELECT run_id
      FROM agent_file_edit_cleanup_outbox
      ORDER BY rowid ASC
    `).all() as Array<{ run_id: string }>
    return rows.map((row) => row.run_id)
  }

  listAttachmentCleanupThreadIds(): string[] {
    const rows = this.database.prepare(`
      SELECT thread_id
      FROM agent_attachment_cleanup_outbox
      ORDER BY rowid ASC
    `).all() as Array<{ thread_id: string }>
    return rows.map((row) => row.thread_id)
  }

  acknowledgeAttachmentCleanup(threadId: string): void {
    requireNonEmptyText(threadId, 'Attachment cleanup thread ID')
    this.database.prepare(`
      DELETE FROM agent_attachment_cleanup_outbox
      WHERE thread_id = ?
    `).run(threadId)
    this.database.prepare('DELETE FROM agent_attachment_file_cleanup_outbox WHERE thread_id = ?').run(threadId)
  }

  listAttachmentFileCleanup(): Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>> {
    assertCleanupStorageIntegrity(this.database)
    const rows = this.database.prepare('SELECT attachment_id, storage_path FROM agent_attachment_file_cleanup_outbox ORDER BY rowid')
      .all() as Array<{ attachment_id: string; storage_path: string }>
    return rows.map((row) => ({ id: row.attachment_id, path: resolve(this.attachmentRoot, row.storage_path) }))
  }

  acknowledgeAttachmentFileCleanup(attachmentId: string): void {
    this.database.prepare('DELETE FROM agent_attachment_file_cleanup_outbox WHERE attachment_id = ?').run(attachmentId)
  }

  private enqueueAttachmentCleanup(threadId: string): void {
    requireNonEmptyText(threadId, 'Attachment cleanup thread ID')
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_attachment_cleanup_outbox (thread_id)
      VALUES (?)
    `).run(threadId)
  }

  listRetainedFileEditOperationIds(requestId: string): string[] {
    requireNonEmptyText(requestId, 'File edit request ID')
    const rows = this.database.prepare(`
      SELECT operation_id
      FROM agent_file_edit_retained_operations
      WHERE request_id = ?
      ORDER BY rowid ASC
    `).all(requestId) as Array<{ operation_id: string }>
    return rows.map((row) => row.operation_id)
  }

  acknowledgeFileEditCleanup(runId: string): void {
    const result = this.database.prepare(`
      DELETE FROM agent_file_edit_cleanup_outbox
      WHERE run_id = ?
    `).run(runId)
    if (result.changes) this.fileChanges.notifyChanged(runId)
  }

  private retainUncommittedFileEdits(runId: string): void {
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_file_edit_retained_operations (
        request_id,
        operation_id
      )
      SELECT
        json_extract(target_json, '$.requestId'),
        json_extract(target_json, '$.operationId')
      FROM agent_effect_journal
      WHERE run_id = ?
        AND effect_kind = 'file_patch'
        AND json_type(target_json, '$.requestId') = 'text'
        AND json_type(target_json, '$.operationId') = 'text'
    `).run(runId)
  }

  getLatestRunForThread(threadId: string): AgentRun | null {
    this.requireThread(threadId)
    const row = this.database.prepare(`
      SELECT id, thread_id, operation, status, created_at, updated_at, error
      FROM agent_runs
      WHERE thread_id = ?
      ORDER BY rowid DESC
      LIMIT 1
    `).get(threadId) as RunRow | undefined
    return row ? runFromRow(row, this.readBackgroundCleanup(row.id)) : null
  }

  createQueuedInput(
    input: AgentQueuedInputCreate,
    attachments: ArchivedAgentAttachment[]
  ): AgentQueuedInput {
    this.notifyChanged()
    this.requireThread(input.threadId)
    const createdAt = timestamp()
    const create = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO agent_queued_inputs (
          id, thread_id, text, display_text, status, error, created_at
        ) VALUES (?, ?, ?, ?, 'queued', NULL, ?)
      `).run(input.id, input.threadId, input.text, input.displayText ?? input.text, createdAt)
      const insertAttachment = this.database.prepare(`
        INSERT INTO agent_queued_attachments (
          id,
          queued_input_id,
          name,
          mime_type,
          size,
          kind,
          storage_path,
          text_truncated,
          context_policy,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const archived of attachments) {
        const artifact = archived.artifact
        if (
          artifact.threadId !== input.threadId
          || artifact.runId !== input.id
          || artifact.messageId !== input.id
        ) {
          throw new Error(`Queued attachment ${artifact.id} does not belong to input ${input.id}.`)
        }
        insertAttachment.run(
          artifact.id,
          input.id,
          artifact.name,
          artifact.mimeType,
          artifact.size,
          artifact.kind,
          archived.storagePath,
          artifact.textTruncated ? 1 : 0,
          artifact.contextPolicy,
          artifact.createdAt
        )
      }
    })
    create()
    return this.requireQueuedInput(input.threadId, input.id)
  }

  listQueuedInputs(): AgentQueuedInput[] {
    const rows = this.database.prepare(`
      SELECT id, thread_id, text, display_text, status, error, created_at
      FROM agent_queued_inputs
      ORDER BY created_at ASC, rowid ASC
    `).all() as QueuedInputRow[]
    const attachmentRows = this.database.prepare(`
      SELECT
        id,
        queued_input_id,
        name,
        mime_type,
        size,
        kind,
        storage_path,
        text_truncated,
        context_policy,
        created_at
      FROM agent_queued_attachments
      ORDER BY created_at ASC, rowid ASC
    `).all() as QueuedAttachmentRow[]
    const attachmentsByInput = new Map<string, SelectedAttachment[]>()
    for (const row of attachmentRows) {
      const attachments = attachmentsByInput.get(row.queued_input_id) ?? []
      attachments.push(this.queuedAttachmentFromRow(row))
      attachmentsByInput.set(row.queued_input_id, attachments)
    }
    return rows.map((row) => this.queuedInputFromRow(
      row,
      attachmentsByInput.get(row.id) ?? []
    ))
  }

  getQueuedInput(threadId: string, queuedInputId: string): AgentQueuedInput | null {
    const row = this.database.prepare(`
      SELECT id, thread_id, text, display_text, status, error, created_at
      FROM agent_queued_inputs
      WHERE id = ? AND thread_id = ?
    `).get(queuedInputId, threadId) as QueuedInputRow | undefined
    if (!row) return null
    const attachments = this.database.prepare(`
      SELECT
        id,
        queued_input_id,
        name,
        mime_type,
        size,
        kind,
        storage_path,
        text_truncated,
        context_policy,
        created_at
      FROM agent_queued_attachments
      WHERE queued_input_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(queuedInputId) as QueuedAttachmentRow[]
    return this.queuedInputFromRow(row, attachments.map((item) => this.queuedAttachmentFromRow(item)))
  }

  listQueuedInputAttachmentArtifacts(
    threadId: string,
    queuedInputId: string
  ): Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>> {
    if (!this.getQueuedInput(threadId, queuedInputId)) return []
    const rows = this.database.prepare(`
      SELECT id, storage_path
      FROM agent_queued_attachments
      WHERE queued_input_id = ?
      ORDER BY rowid ASC
    `).all(queuedInputId) as Array<{ id: string; storage_path: string }>
    return rows.map((row) => ({
      id: row.id,
      path: resolve(this.attachmentRoot, row.storage_path)
    }))
  }

  deleteQueuedInput(threadId: string, queuedInputId: string): boolean {
    this.notifyChanged()
    return this.database.prepare(`
      DELETE FROM agent_queued_inputs
      WHERE id = ? AND thread_id = ?
    `).run(queuedInputId, threadId).changes > 0
  }

  markQueuedInputFailed(
    threadId: string,
    queuedInputId: string,
    error: string
  ): AgentQueuedInput {
    this.notifyChanged()
    const changed = this.database.prepare(`
      UPDATE agent_queued_inputs
      SET status = 'failed', error = ?
      WHERE id = ? AND thread_id = ?
    `).run(error, queuedInputId, threadId).changes
    if (changed === 0) throw new Error(`Queued input ${queuedInputId} was not found.`)
    return this.requireQueuedInput(threadId, queuedInputId)
  }

  retryQueuedInput(threadId: string, queuedInputId: string): AgentQueuedInput {
    this.notifyChanged()
    const changed = this.database.prepare(`
      UPDATE agent_queued_inputs
      SET status = 'queued', error = NULL
      WHERE id = ? AND thread_id = ?
    `).run(queuedInputId, threadId).changes
    if (changed === 0) throw new Error(`Queued input ${queuedInputId} was not found.`)
    return this.requireQueuedInput(threadId, queuedInputId)
  }

  listAttachmentsForThread(threadId: string): AgentAttachmentArtifact[] {
    this.requireThread(threadId)
    const rows = this.database.prepare(`
      SELECT
        id,
        thread_id,
        message_id,
        run_id,
        name,
        mime_type,
        size,
        kind,
        storage_path,
        text_truncated,
        context_policy,
        created_at
      FROM agent_attachments
      WHERE thread_id = ?
      ORDER BY rowid ASC
    `).all(threadId) as AttachmentRow[]
    return rows.map((row) => this.attachmentFromRow(row))
  }

  listAttachmentsForMessage(
    threadId: string,
    messageId: string
  ): AgentAttachmentArtifact[] {
    this.requireThread(threadId)
    const rows = this.database.prepare(`
      SELECT
        id,
        thread_id,
        message_id,
        run_id,
        name,
        mime_type,
        size,
        kind,
        storage_path,
        text_truncated,
        context_policy,
        created_at
      FROM agent_attachments
      WHERE thread_id = ? AND message_id = ?
      ORDER BY rowid ASC
    `).all(threadId, messageId) as AttachmentRow[]
    return rows.map((row) => this.attachmentFromRow(row))
  }

  listAttachmentsFromRun(runId: string): AgentAttachmentArtifact[] {
    const target = this.requireRun(runId)
    const row = this.database.prepare(`
      SELECT rowid
      FROM agent_runs
      WHERE id = ?
    `).get(runId) as { rowid: number }
    const rows = this.database.prepare(`
      SELECT
        attachment.id,
        attachment.thread_id,
        attachment.message_id,
        attachment.run_id,
        attachment.name,
        attachment.mime_type,
        attachment.size,
        attachment.kind,
        attachment.storage_path,
        attachment.text_truncated,
        attachment.context_policy,
        attachment.created_at
      FROM agent_attachments attachment
      INNER JOIN agent_runs run ON run.id = attachment.run_id
      WHERE run.thread_id = ? AND run.rowid >= ?
      ORDER BY attachment.rowid ASC
    `).all(target.threadId, row.rowid) as AttachmentRow[]
    return rows.map((attachment) => this.attachmentFromRow(attachment))
  }

  recordToolActivity(
    runId: string,
    call: AgentToolCall,
    status: 'running' | 'completed',
    subagentId?: string,
    output?: unknown
  ): AgentToolActivity {
    const key = JSON.stringify([runId, subagentId ?? null, call.id])
    const canonical = this.database.prepare(`SELECT model_message_id, tool_message_id FROM agent_tool_messages
      WHERE thread_id = ? AND run_id = ? AND call_id = ?`)
      .get(this.activitySourceThread(runId, subagentId), this.activitySourceRun(runId, subagentId), call.id) as {
        model_message_id: string | null; tool_message_id: string | null
      } | undefined
    if (canonical?.model_message_id && (output === undefined || canonical.tool_message_id)) this.transientTools.delete(key)
    else this.transientTools.set(key, { call: canonical?.model_message_id ? { ...call, args: {} } : call, output })
    const activity = this.upsertActivity({
      runId,
      key: toolActivityKey(call.id, subagentId),
      kind: 'tool',
      id: call.id,
      parentSubagentId: subagentId,
      name: call.name,
      status,
      output: undefined
    })
    if (status === 'completed') this.clearToolApproval(runId, call.id, subagentId)
    return { call, status, subagentId, output, ...activity }
  }

  recordToolApproval(
    runId: string,
    callId: string,
    approval: AgentToolApproval,
    subagentId?: string
  ): void {
    this.requireRun(runId)
    const activityKey = toolActivityKey(callId, subagentId)
    const activity = this.database.prepare(`
      SELECT kind
      FROM agent_activities
      WHERE run_id = ? AND activity_key = ?
    `).get(runId, activityKey) as { kind: ActivityRow['kind'] } | undefined
    if (activity?.kind !== 'tool') {
      throw new Error(`Tool activity ${callId} was not found for run ${runId}.`)
    }
    this.database.prepare(`
      INSERT INTO agent_tool_approvals (
        run_id,
        activity_key,
        interrupt_id,
        action_index
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (run_id, activity_key) DO UPDATE SET
        interrupt_id = excluded.interrupt_id,
        action_index = excluded.action_index
    `).run(
      runId,
      activityKey,
      approval.interruptId,
      approval.actionIndex
    )
  }

  clearToolApproval(runId: string, callId: string, subagentId?: string): void {
    this.database.prepare(`
      DELETE FROM agent_tool_approvals
      WHERE run_id = ? AND activity_key = ?
    `).run(runId, toolActivityKey(callId, subagentId))
  }

  recordSubagentActivity(
    runId: string,
    id: string,
    name: string,
    status: AgentSubagentActivity['status'],
    parentSubagentId?: string,
    result?: unknown,
    error?: string
  ): AgentSubagentActivity {
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
    const payload: SubagentActivityPayload = {
      status,
      ...(status === 'completed' && result !== undefined ? { result } : {}),
      ...(error === undefined ? {} : { error })
    }
    const activity = this.upsertActivity({
      runId,
      key: `subagent:${id}`,
      kind: 'subagent',
      id,
      parentSubagentId,
      name,
      status: terminal ? 'completed' : 'running',
      output: {status}
    })
    return {
      id,
      name,
      status,
      parentSubagentId,
      ...(payload.result === undefined ? {} : { result: payload.result }),
      ...(payload.error === undefined ? {} : { error: payload.error }),
      ...activity
    }
  }

  recordProjectedSubagentActivity(
    carrierSubagentId: string,
    ownerThreadId: string,
    activity: Omit<AgentSubagentActivity, 'sequence' | 'startedAt' | 'completedAt'>
  ): AgentSubagentActivity {
    const carrier = this.requireSubagentCall(carrierSubagentId, ownerThreadId)
    this.requireProjectedSubagentDescendant(carrier, activity.id)
    const project = this.database.transaction(() => {
      let direct: AgentSubagentActivity | undefined
      for (const [index, ancestor] of this.subagentProjectionChain(carrier).entries()) {
        const recorded = this.recordSubagentActivity(
          ancestor.parentRunId,
          activity.id,
          activity.name,
          activity.status,
          activity.parentSubagentId,
          activity.result,
          activity.error
        )
        if (index === 0) direct = recorded
        else if (direct) {
          this.alignProjectedActivityTiming(
            ancestor.parentRunId,
            `subagent:${activity.id}`,
            direct
          )
        }
      }
      if (!direct) throw new Error(`Subagent ${carrierSubagentId} has no projection target.`)
      return direct
    })
    return project()
  }

  recordProjectedModelActivity(
    carrierSubagentId: string,
    ownerThreadId: string,
    model: Omit<AgentModelActivity, 'sequence' | 'startedAt' | 'completedAt'> & {
      subagentId: string
    }
  ): AgentModelActivity {
    const carrier = this.requireSubagentCall(carrierSubagentId, ownerThreadId)
    this.requireProjectedSubagentDescendant(carrier, model.subagentId)
    const project = this.database.transaction(() => {
      let direct: AgentModelActivity | undefined
      for (const [index, ancestor] of this.subagentProjectionChain(carrier).entries()) {
        const recorded = this.recordModelActivity(ancestor.parentRunId, model)
        if (index === 0) direct = recorded
        else if (direct) {
          this.alignProjectedActivityTiming(
            ancestor.parentRunId,
            `model:${model.id}`,
            direct
          )
        }
      }
      if (!direct) throw new Error(`Subagent ${carrierSubagentId} has no projection target.`)
      return direct
    })
    return project()
  }

  recordProjectedToolActivity(
    carrierSubagentId: string,
    ownerThreadId: string,
    call: AgentToolCall,
    status: 'running' | 'completed',
    projectedSubagentId: string,
    output?: unknown
  ): AgentToolActivity {
    const carrier = this.requireSubagentCall(carrierSubagentId, ownerThreadId)
    this.requireProjectedSubagentDescendant(carrier, projectedSubagentId)
    const project = this.database.transaction(() => {
      let direct: AgentToolActivity | undefined
      for (const [index, ancestor] of this.subagentProjectionChain(carrier).entries()) {
        const recorded = this.recordToolActivity(
          ancestor.parentRunId,
          call,
          status,
          projectedSubagentId,
          output
        )
        if (index === 0) direct = recorded
        else if (direct) {
          this.alignProjectedActivityTiming(
            ancestor.parentRunId,
            toolActivityKey(call.id, projectedSubagentId),
            direct
          )
        }
      }
      if (!direct) throw new Error(`Subagent ${carrierSubagentId} has no projection target.`)
      return direct
    })
    return project()
  }

  recordProjectedToolApproval(
    carrierSubagentId: string,
    ownerThreadId: string,
    call: AgentToolCall,
    approval: AgentToolApproval,
    projectedSubagentId: string
  ): AgentToolActivity {
    const carrier = this.requireSubagentCall(carrierSubagentId, ownerThreadId)
    this.requireProjectedSubagentDescendant(carrier, projectedSubagentId)
    const project = this.database.transaction(() => {
      let direct: AgentToolActivity | undefined
      for (const [index, ancestor] of this.subagentProjectionChain(carrier).entries()) {
        const recorded = this.recordToolActivity(
          ancestor.parentRunId,
          call,
          'running',
          projectedSubagentId
        )
        this.recordToolApproval(
          ancestor.parentRunId,
          call.id,
          approval,
          projectedSubagentId
        )
        if (index === 0) direct = recorded
        else if (direct) {
          this.alignProjectedActivityTiming(
            ancestor.parentRunId,
            toolActivityKey(call.id, projectedSubagentId),
            direct
          )
        }
      }
      if (!direct) throw new Error(`Subagent ${carrierSubagentId} has no projection target.`)
      return { ...direct, approval }
    })
    return project()
  }

  private recordSubagentActivityForCall(call: AgentSubagentCallRecord): AgentSubagentActivity {
    return this.recordProjectedSubagentActivity(
      call.id,
      call.ownerThreadId,
      {
        id: call.id,
        name: call.agentName,
        status: call.status,
        parentSubagentId: call.parentSubagentId,
        result: call.result,
        error: call.error
      }
    )
  }

  private settleProjectedActivitiesForSubagent(
    subagentId: string,
    completedAt: string
  ): void {
    this.database.prepare(`
      UPDATE agent_activity_timing
      SET completed_at = COALESCE(completed_at, ?)
      WHERE EXISTS (
        SELECT 1
        FROM agent_model_activities AS model
        WHERE model.run_id = agent_activity_timing.run_id
          AND agent_activity_timing.activity_key = 'model:' || model.model_id
          AND model.subagent_id = ?
          AND model.status = 'running'
      )
    `).run(completedAt, subagentId)
    this.database.prepare(`
      UPDATE agent_model_activities
      SET status = 'completed'
      WHERE subagent_id = ? AND status = 'running'
    `).run(subagentId)

    this.database.prepare(`
      UPDATE agent_activity_timing
      SET completed_at = COALESCE(completed_at, ?)
      WHERE EXISTS (
        SELECT 1
        FROM agent_activities AS activity
        WHERE activity.run_id = agent_activity_timing.run_id
          AND activity.activity_key = agent_activity_timing.activity_key
          AND activity.kind = 'tool'
          AND activity.parent_subagent_id = ?
          AND activity.status = 'running'
      )
    `).run(completedAt, subagentId)
    this.database.prepare(`
      DELETE FROM agent_tool_approvals
      WHERE EXISTS (
        SELECT 1
        FROM agent_activities AS activity
        WHERE activity.run_id = agent_tool_approvals.run_id
          AND activity.activity_key = agent_tool_approvals.activity_key
          AND activity.kind = 'tool'
          AND activity.parent_subagent_id = ?
      )
    `).run(subagentId)
    this.database.prepare(`
      UPDATE agent_activities
      SET status = 'completed'
      WHERE kind = 'tool'
        AND parent_subagent_id = ?
        AND status = 'running'
    `).run(subagentId)
  }

  private subagentProjectionChain(
    carrier: AgentSubagentCallRecord
  ): AgentSubagentCallRecord[] {
    const chain = [carrier]
    const visited = new Set([carrier.id])
    let parentSubagentId = carrier.parentSubagentId
    while (parentSubagentId) {
      if (visited.has(parentSubagentId)) throw new Error('Subagent ancestry contains a cycle.')
      visited.add(parentSubagentId)
      const parent = this.requireSubagentCall(parentSubagentId, carrier.ownerThreadId)
      chain.push(parent)
      parentSubagentId = parent.parentSubagentId
    }
    return chain
  }

  private requireProjectedSubagentDescendant(
    carrier: AgentSubagentCallRecord,
    projectedSubagentId: string
  ): AgentSubagentCallRecord {
    let projected = this.requireSubagentCall(projectedSubagentId, carrier.ownerThreadId)
    const visited = new Set<string>()
    while (true) {
      if (visited.has(projected.id)) throw new Error('Subagent ancestry contains a cycle.')
      visited.add(projected.id)
      if (projected.id === carrier.id) return projected
      if (!projected.parentSubagentId) {
        throw new Error(
          `Subagent ${projectedSubagentId} is not a descendant of ${carrier.id}.`
        )
      }
      projected = this.requireSubagentCall(projected.parentSubagentId, carrier.ownerThreadId)
    }
  }

  private alignProjectedActivityTiming(
    runId: string,
    activityKey: string,
    source: { startedAt?: string; completedAt?: string }
  ): void {
    if (!source.startedAt) return
    this.database.prepare(`
      UPDATE agent_activity_timing
      SET started_at = ?, completed_at = ?
      WHERE run_id = ? AND activity_key = ?
    `).run(source.startedAt, source.completedAt ?? null, runId, activityKey)
  }

  recordModelActivity(
    runId:string,
    model:Omit<AgentModelActivity,'sequence'|'startedAt'|'completedAt'>
  ): AgentModelActivity {
    this.requireRun(runId)
    const key = JSON.stringify([runId, model.id])
    const messageId = model.messageId ?? (this.database.prepare('SELECT message_id FROM agent_model_messages WHERE run_id = ? AND model_id = ?')
      .get(runId, model.id) as { message_id: string } | undefined)?.message_id
    const canonical = messageId && this.database.prepare(`SELECT 1 FROM agent_message_payloads
      WHERE thread_id = ? AND run_id = ? AND message_id = ?`)
      .get(this.activitySourceThread(runId, model.subagentId), this.activitySourceRun(runId, model.subagentId), messageId)
    if (canonical) this.transientModels.delete(key)
    else if (model.status === 'completed') this.transientModels.set(key, model)
    this.database.prepare(`INSERT INTO agent_model_activities(run_id,model_id,sequence,subagent_id,status)
      VALUES(?,?,?,?,?) ON CONFLICT(run_id,model_id) DO UPDATE SET subagent_id=excluded.subagent_id,status=excluded.status`)
      .run(runId,model.id,this.nextActivitySequence(runId),model.subagentId ?? null,model.status)
    if(model.messageId) this.database.prepare(`INSERT INTO agent_model_messages(run_id,model_id,message_id) VALUES(?,?,?)
      ON CONFLICT(run_id,model_id) DO UPDATE SET message_id=excluded.message_id`).run(runId,model.id,model.messageId)
    const row=this.database.prepare(`SELECT model.sequence, ${modelRoundSql} AS model_round
      FROM agent_model_activities model WHERE model.run_id=? AND model.model_id=?`).get(runId,model.id) as {sequence:number;model_round:number}
    return {...model,sequence:row.sequence,round:row.model_round,...this.recordActivityTiming(runId,`model:${model.id}`,model.status)}
  }

  discardModelActivity(runId: string, modelId: string): boolean {
    this.requireRun(runId)
    return this.database.transaction(() => {
      const result = this.database.prepare(`
        DELETE FROM agent_model_activities
        WHERE run_id = ? AND model_id = ?
      `).run(runId, modelId)
      if (result.changes === 0) return false
      this.database.prepare(`
        DELETE FROM agent_activity_timing
        WHERE run_id = ? AND activity_key = ?
      `).run(runId, `model:${modelId}`)
      return true
    })()
  }

  canonicalSubagentActivityEvidence(runId: string) {
    const calls = this.database.prepare(`
      WITH RECURSIVE descendants(id, child_run_id) AS (
        SELECT id, child_run_id FROM agent_subagent_calls WHERE parent_run_id = ?
        UNION
        SELECT child.id, child.child_run_id FROM agent_subagent_calls child
        JOIN descendants parent ON child.parent_run_id = parent.child_run_id
      ) SELECT id FROM descendants
    `).all(runId) as Array<{ id: string }>
    const subagentIds = new Set(calls.map((call) => call.id))
    const selected = JSON.stringify([...subagentIds])
    const models = this.database.prepare(`
      SELECT model.model_id FROM agent_model_activities model
      JOIN agent_subagent_calls call ON call.id = model.subagent_id
      JOIN agent_model_messages message ON message.run_id = model.run_id AND message.model_id = model.model_id
      JOIN agent_message_payloads payload ON payload.thread_id = call.child_thread_id
        AND payload.run_id = call.child_run_id AND payload.message_id = message.message_id
      WHERE model.run_id = ? AND call.id IN (SELECT value FROM json_each(?))
    `).all(runId, selected) as Array<{ model_id: string }>
    const tools = this.database.prepare(`
      SELECT activity.activity_id, activity.parent_subagent_id, tool.tool_message_id
      FROM agent_activities activity
      JOIN agent_subagent_calls call ON call.id = activity.parent_subagent_id
      JOIN agent_tool_messages tool ON tool.thread_id = call.child_thread_id
        AND tool.run_id = call.child_run_id AND tool.call_id = activity.activity_id
      WHERE activity.run_id = ? AND activity.kind = 'tool' AND tool.model_message_id IS NOT NULL
        AND call.id IN (SELECT value FROM json_each(?))
    `).all(runId, selected) as Array<{ activity_id: string; parent_subagent_id: string; tool_message_id: string | null }>
    return {
      subagentIds,
      modelIds: new Set(models.map((model) => model.model_id)),
      tools: new Map(tools.map((tool) => [
        JSON.stringify([tool.parent_subagent_id, tool.activity_id]),
        { completed: tool.tool_message_id !== null }
      ]))
    }
  }

  reconcileRootActivities(
    runId: string,
    evidence: DurableRootActivityEvidence
  ): void {
    this.requireRun(runId)
    const durableModels = new Map(evidence.models.map((model) => [model.messageId, model]))
    const durableTools = new Map(evidence.tools.map((tool) => [tool.call.id, tool]))
    const canonicalChildren = this.canonicalSubagentActivityEvidence(runId)
    const reconcile = this.database.transaction(() => {
      const modelRows = this.database.prepare(`
        SELECT model.model_id, message.message_id
        FROM agent_model_activities model
        LEFT JOIN agent_model_messages message
          ON message.run_id = model.run_id
          AND message.model_id = model.model_id
        WHERE model.run_id = ? AND model.subagent_id IS NULL
        ORDER BY model.sequence ASC
      `).all(runId) as Array<{ model_id: string; message_id: string | null }>
      const claimedModelMessages = new Set<string>()
      const existingModelIds = new Map<string, string>()
      const deleteModel = this.database.prepare(`
        DELETE FROM agent_model_activities
        WHERE run_id = ? AND model_id = ?
      `)
      const deleteTiming = this.database.prepare(`
        DELETE FROM agent_activity_timing
        WHERE run_id = ? AND activity_key = ?
      `)
      for (const row of modelRows) {
        if (
          row.message_id
          && durableModels.has(row.message_id)
          && !claimedModelMessages.has(row.message_id)
        ) {
          claimedModelMessages.add(row.message_id)
          existingModelIds.set(row.message_id, row.model_id)
          continue
        }
        deleteModel.run(runId, row.model_id)
        deleteTiming.run(runId, `model:${row.model_id}`)
      }
      for (const model of evidence.models) {
        this.recordModelActivity(runId, {
          id: existingModelIds.get(model.messageId) ?? `checkpoint:${model.messageId}`,
          messageId: model.messageId,
          status: 'completed',
          text: model.text,
          reasoning: model.reasoning,
          toolCallIds: model.toolCalls.map((call) => call.id)
        })
      }

      const existingDurableRootSubagents = new Set((this.database.prepare(`
        SELECT activity_id
        FROM agent_activities
        WHERE run_id = ? AND kind = 'subagent' AND parent_subagent_id IS NULL
      `).all(runId) as Array<{ activity_id: string }>).map((row) => row.activity_id))
      for (const durable of evidence.tools) {
        if (
          !durable.subagentName
          || !durable.subagentId
          || existingDurableRootSubagents.has(durable.subagentId)
        ) continue
        this.recordSubagentActivity(
          runId,
          durable.subagentId,
          durable.subagentName,
          'running'
        )
        existingDurableRootSubagents.add(durable.subagentId)
      }

      // Restore missing descendant metadata while preserving existing order
      // and timing. Their bodies are validated against child messages below.
      this.reconcileMissingSubagentAncestorActivities(runId)
      const activityRows = this.database.prepare(`
        SELECT activity_key, kind, activity_id, parent_subagent_id, name
        FROM agent_activities
        WHERE run_id = ?
        ORDER BY sequence ASC
      `).all(runId) as Array<{
        activity_key: string
        kind: ActivityRow['kind']
        activity_id: string
        parent_subagent_id: string | null
        name: string
      }>
      // A committed child call proves the relationship independently of the
      // later root ToolMessage. Child model/tool bodies still need their own
      // canonical messages; retaining a relationship never validates partial output.
      const allowedSubagents = new Set(evidence.tools.flatMap((tool) =>
        tool.subagentId ? [tool.subagentId] : []
      ))
      let discoveredSubagent = true
      while (discoveredSubagent) {
        discoveredSubagent = false
        for (const row of activityRows) {
          if (
            row.kind === 'subagent'
            && row.parent_subagent_id
            && allowedSubagents.has(row.parent_subagent_id)
            && !allowedSubagents.has(row.activity_id)
          ) {
            allowedSubagents.add(row.activity_id)
            discoveredSubagent = true
          }
        }
      }
      const nestedModelRows = this.database.prepare(`
        SELECT model_id, subagent_id
        FROM agent_model_activities
        WHERE run_id = ? AND subagent_id IS NOT NULL
      `).all(runId) as Array<{ model_id: string; subagent_id: string }>
      for (const row of nestedModelRows) {
        if (canonicalChildren.subagentIds.has(row.subagent_id)
          ? canonicalChildren.modelIds.has(row.model_id)
          : allowedSubagents.has(row.subagent_id)) continue
        deleteModel.run(runId, row.model_id)
        deleteTiming.run(runId, `model:${row.model_id}`)
      }
      const deleteActivity = this.database.prepare(`
        DELETE FROM agent_activities
        WHERE run_id = ? AND activity_key = ?
      `)
      for (const row of activityRows) {
        if (row.kind === 'subagent' && canonicalChildren.subagentIds.has(row.activity_id)) continue
        if (row.kind === 'tool' && row.parent_subagent_id && canonicalChildren.subagentIds.has(row.parent_subagent_id)) {
          const canonicalTool = canonicalChildren.tools.get(JSON.stringify([row.parent_subagent_id, row.activity_id]))
          if (canonicalTool) {
            this.database.prepare('UPDATE agent_activities SET status = ? WHERE run_id = ? AND activity_key = ?')
              .run(canonicalTool.completed ? 'completed' : 'running', runId, row.activity_key)
            if (!canonicalTool.completed) this.database.prepare(`
              UPDATE agent_activity_timing SET completed_at = NULL WHERE run_id = ? AND activity_key = ?
            `).run(runId, row.activity_key)
            continue
          }
          deleteActivity.run(runId, row.activity_key)
          deleteTiming.run(runId, row.activity_key)
          continue
        }
        if (
          !row.parent_subagent_id
          || allowedSubagents.has(row.parent_subagent_id)
        ) continue
        deleteActivity.run(runId, row.activity_key)
        deleteTiming.run(runId, row.activity_key)
      }
      const existingRootTools = new Set<string>()
      const existingRootSubagents = new Set<string>()
      for (const row of activityRows) {
        if (row.parent_subagent_id) continue
        const durable = durableTools.get(row.activity_id)
        const durableSubagent = evidence.tools.find((tool) => tool.subagentId === row.activity_id)
        if (!durable && !durableSubagent && !(row.kind === 'subagent' && canonicalChildren.subagentIds.has(row.activity_id))) {
          deleteActivity.run(runId, row.activity_key)
          deleteTiming.run(runId, row.activity_key)
          continue
        }
        if (row.kind === 'tool') {
          if (!durable) continue
          existingRootTools.add(row.activity_id)
          this.recordToolActivity(runId, durable.call, 'completed', undefined, durable.output)
        } else {
          existingRootSubagents.add(row.activity_id)
        }
      }
      for (const durable of evidence.tools) {
        if (!existingRootTools.has(durable.call.id)) {
          this.recordToolActivity(runId, durable.call, 'completed', undefined, durable.output)
        }
        if (durable.subagentName && durable.subagentId && !existingRootSubagents.has(durable.subagentId)) {
          this.recordSubagentActivity(
            runId,
            durable.subagentId,
            durable.subagentName,
            'running'
          )
        }
      }
    })
    reconcile()
  }

  recordContextSummaryStarted(runId: string, summaryId: string = randomUUID()): AgentContextSummary {
    this.requireRun(runId)
    const sequence = this.nextActivitySequence(runId)
    const createdAt = timestamp()
    this.database.prepare(`
      INSERT INTO agent_context_summaries (
        run_id,
        summary_id,
        sequence,
        status,
        created_at
      ) VALUES (?, ?, ?, 'running', ?)
    `).run(runId, summaryId, sequence, createdAt)
    return {
      id: summaryId,
      sequence,
      status: 'running',
      summaryText: '',
      createdAt
    }
  }

  recordMemoryRecall(
    runId: string,
    recall: Omit<AgentMemoryRecall, 'sequence' | 'createdAt'>
  ): AgentMemoryRecall {
    this.requireRun(runId)
    requireNonEmptyText(recall.id, 'Memory recall ID')
    requireNonEmptyText(recall.query, 'Memory recall query')
    requireNonEmptyText(recall.promptText, 'Memory recall prompt')
    if (!Number.isInteger(recall.memoryCount) || recall.memoryCount < 1) {
      throw new Error('Memory recall count must be a positive integer.')
    }
    if (recall.agentName !== undefined) requireNonEmptyText(recall.agentName, 'Memory recall Agent name')
    const sequence = this.nextActivitySequence(runId)
    const createdAt = timestamp()
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_memory_recalls (
        run_id,
        recall_id,
        sequence,
        query,
        prompt_text,
        memory_count,
        agent_name,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      recall.id,
      sequence,
      recall.query,
      recall.promptText,
      recall.memoryCount,
      recall.agentName ?? null,
      createdAt
    )
    const row = this.database.prepare(`
      SELECT run_id, recall_id, sequence, query, prompt_text, memory_count, agent_name, created_at
      FROM agent_memory_recalls
      WHERE run_id = ? AND recall_id = ?
    `).get(runId, recall.id) as MemoryRecallRow | undefined
    if (!row) throw new Error(`Memory recall ${recall.id} was not recorded.`)
    return memoryRecallFromRow(row)
  }

  stageContextSummary(
    runId: string,
    summaryId: string,
    details: StagedContextSummaryDetails
  ): AgentContextSummary {
    this.requireRun(runId)
    const result = this.database.prepare(`
      UPDATE agent_context_summaries
      SET summary_text = @summaryText,
          model_content = @modelContent,
          cutoff_index = @cutoffIndex,
          activated_after_message_index = @activatedAfterMessageIndex,
          covered_through_message_id = @coveredThroughMessageId,
          first_preserved_message_id = @firstPreservedMessageId,
          input_tokens_before = @inputTokensBefore,
          input_tokens_after = @inputTokensAfter
      WHERE run_id = @runId
        AND summary_id = @summaryId
        AND status = 'running'
        AND committed_checkpoint_id IS NULL
    `).run({
      runId,
      summaryId,
      summaryText: details.summaryText,
      modelContent: details.modelContent ?? '',
      cutoffIndex: details.cutoffIndex ?? null,
      activatedAfterMessageIndex: details.activatedAfterMessageIndex ?? null,
      coveredThroughMessageId: details.coveredThroughMessageId ?? null,
      firstPreservedMessageId: details.firstPreservedMessageId ?? null,
      inputTokensBefore: details.inputTokensBefore ?? null,
      inputTokensAfter: details.inputTokensAfter ?? null
    })
    if (result.changes !== 1) {
      throw new Error(`Context summary ${summaryId} is not available for staging in run ${runId}.`)
    }
    return this.requireContextSummary(runId, summaryId)
  }

  getCommittedContextSummary(runId: string, summaryId: string): StoredContextSummary|undefined {
    const row=this.database.prepare("SELECT * FROM agent_context_summaries WHERE run_id=? AND summary_id=? AND status='completed'").get(runId,summaryId) as ContextSummaryRow|undefined
    return row ? this.storedContextSummaryFromRow(row) : undefined
  }

  commitContextSummary(
    runId: string,
    summaryId: string,
    checkpointId: string
  ): StoredContextSummary {
    const commit = this.database.transaction(() => {
      const row = this.requireContextSummaryRow(runId, summaryId)
      const checkpoint = this.database.prepare(`
        SELECT 1
        FROM current_state checkpoint
        INNER JOIN agent_runs run ON run.thread_id = checkpoint.thread_id
        WHERE run.id = ?
          AND checkpoint.checkpoint_ns = ''
          AND checkpoint.checkpoint_id = ?
      `).get(runId, checkpointId)
      if (!checkpoint) {
        throw new Error(`Checkpoint ${checkpointId} is not a durable root checkpoint for run ${runId}.`)
      }
      if (row.cutoff_index === null || row.activated_after_message_index === null) {
        throw new Error(`Context summary ${summaryId} has no staged checkpoint boundary.`)
      }
      if (row.status === 'completed') {
        if (row.committed_checkpoint_id !== checkpointId) {
          throw new Error(`Context summary ${summaryId} is already committed to another checkpoint.`)
        }
        return this.storedContextSummaryFromRow(row)
      }
      const result = this.database.prepare(`
        UPDATE agent_context_summaries
        SET status = 'completed', committed_checkpoint_id = ?
        WHERE run_id = ?
          AND summary_id = ?
          AND status = 'running'
          AND committed_checkpoint_id IS NULL
      `).run(checkpointId, runId, summaryId)
      if (result.changes !== 1) {
        throw new Error(`Context summary ${summaryId} could not be committed.`)
      }
      return this.storedContextSummaryFromRow(this.requireContextSummaryRow(runId, summaryId))
    })
    return commit()
  }

  reconcileContextSummariesForCheckpoint(
    threadId: string,
    checkpointId: string,
    match: ContextSummaryCheckpointMatch | undefined,
    scope: ContextSummaryReconcileScope
  ): StoredContextSummary | undefined {
    this.requireThread(threadId)
    const reconcile = this.database.transaction(() => {
      const checkpoint = this.database.prepare(`
        SELECT 1
        FROM current_state
        WHERE thread_id = ?
          AND checkpoint_ns = ''
          AND checkpoint_id = ?
      `).get(threadId, checkpointId)
      if (!checkpoint) {
        throw new Error(`Checkpoint ${checkpointId} is not a durable root checkpoint for thread ${threadId}.`)
      }
      const staged = this.stagedContextSummaryRowsForThread(threadId)
      const candidate = match
        ? staged.find((row) =>
            (match.runId === undefined || row.run_id === match.runId)
            && row.summary_id === match.summaryId
            && row.model_content === match.modelContent
            && row.cutoff_index === match.cutoffIndex
          )
        : undefined
      const committed = candidate
        ? this.commitContextSummary(candidate.run_id, candidate.summary_id, checkpointId)
        : undefined
      if (scope.type === 'run') {
        this.database.prepare(`
          DELETE FROM agent_context_summaries
          WHERE status = 'running'
            AND run_id = ?
            AND run_id IN (SELECT id FROM agent_runs WHERE thread_id = ?)
        `).run(scope.runId, threadId)
      }
      return committed
    })
    return reconcile()
  }

  deleteContextSummary(runId: string, summaryId: string): void {
    this.requireRun(runId)
    this.database.prepare(`
      DELETE FROM agent_context_summaries
      WHERE run_id = ? AND summary_id = ?
    `).run(runId, summaryId)
  }

  contextSummariesThroughRun(threadId: string, runId: string): StoredContextSummary[] {
    this.requireThread(threadId)
    const rows = this.database.prepare(`
      SELECT
        summary.run_id,
        summary.summary_id,
        summary.sequence,
        summary.status,
        summary.summary_text,
        summary.model_content,
        summary.committed_checkpoint_id,
        summary.cutoff_index,
        summary.activated_after_message_index,
        summary.covered_through_message_id,
        summary.first_preserved_message_id,
        summary.input_tokens_before,
        summary.input_tokens_after,
        summary.created_at
      FROM agent_context_summaries summary
      INNER JOIN agent_runs run ON run.id = summary.run_id
      INNER JOIN agent_runs target ON target.id = ?
      WHERE run.thread_id = ?
        AND run.rowid <= target.rowid
        AND summary.status = 'completed'
        AND summary.committed_checkpoint_id IS NOT NULL
        AND summary.cutoff_index IS NOT NULL
        AND summary.activated_after_message_index IS NOT NULL
      ORDER BY run.rowid ASC, summary.sequence ASC
    `).all(runId, threadId) as ContextSummaryRow[]
    return rows.map((row) => this.storedContextSummaryFromRow(row))
  }

  getActivitiesForThread(threadId: string): AgentRunActivity[] {
    return this.readActivities(threadId)
  }

  private readActivities(threadId: string, runIds?: string[], beforeSequence = Number.MAX_SAFE_INTEGER): AgentRunActivity[] {
    this.requireThread(threadId)
    const runRows = this.database.prepare(`
      SELECT
        run.id AS run_id,
        run.operation AS run_operation,
        run.status AS run_status,
        run.error AS run_error,
        run.created_at AS run_created_at,
        run.updated_at AS run_updated_at
      FROM agent_runs run
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC
    `).all({threadId,runIds:runIds === undefined ? null : JSON.stringify(runIds)}) as ActivityRunRow[]
    const runs = new Map<string, AgentRunActivity>(runRows.map((row) => [
      row.run_id,
      {
        runId: row.run_id,
        operation: row.run_operation,
        status: row.run_status,
        error: row.run_error ?? undefined,
        backgroundCleanup: this.readBackgroundCleanup(row.run_id),
        createdAt: row.run_created_at,
        updatedAt: row.run_updated_at,
        models: [],
        tools: [],
        subagents: []
      }
    ]))
    const windows = runRows.map((run) => {
      const source = `SELECT sequence FROM agent_activities WHERE run_id=@runId
        UNION ALL SELECT sequence FROM agent_model_activities WHERE run_id=@runId
        UNION ALL SELECT sequence FROM agent_context_summaries WHERE run_id=@runId
        UNION ALL SELECT sequence FROM agent_memory_recalls WHERE run_id=@runId`
      const candidates = this.database.prepare(`SELECT sequence FROM (${source})
        WHERE sequence < @before ORDER BY sequence DESC LIMIT 101`).all({ runId: run.run_id, before: beforeSequence }) as Array<{ sequence: number }>
      const selected = candidates.slice(0, 100)
      const total = this.database.prepare(`SELECT count(*) AS count FROM (${source})`).get({ runId: run.run_id }) as { count: number }
      const start = selected.at(-1)?.sequence ?? beforeSequence
      runs.get(run.run_id)!.activityWindow = {
        startSequence: selected.length ? start : null, endSequence: selected[0]?.sequence ?? null,
        totalCount: total.count, hasEarlier: candidates.length > selected.length
      }
      return { runId: run.run_id, start, before: beforeSequence }
    })
    const windowParameters = { threadId, runIds: runIds === undefined ? null : JSON.stringify(runIds), windows: JSON.stringify(windows) }
    const rows = this.database.prepare(`
      SELECT
        activity.run_id,
        activity.sequence,
        activity.kind,
        activity.activity_id,
        activity.parent_subagent_id,
        activity.name,
        activity.status,
        activity.output_json,
        approval.interrupt_id AS approval_interrupt_id,
        approval.action_index AS approval_action_index,
        subagent.agent_name AS subagent_name,
        subagent.parent_subagent_id AS subagent_parent_id,
        subagent.status AS subagent_status,
        subagent.result_text AS subagent_result_text,
        subagent.error AS subagent_error,
        subagent.updated_at AS subagent_updated_at,
        timing.started_at,
        timing.completed_at
      FROM agent_activities activity
      INNER JOIN agent_runs run ON run.id = activity.run_id
      INNER JOIN json_each(@windows) page_window ON json_extract(page_window.value, '$.runId')=run.id
        AND activity.sequence >= json_extract(page_window.value, '$.start')
        AND activity.sequence < json_extract(page_window.value, '$.before')
      INNER JOIN agent_activity_timing timing
        ON timing.run_id = activity.run_id
        AND timing.activity_key = activity.activity_key
      LEFT JOIN agent_tool_approvals approval
        ON approval.run_id = activity.run_id
        AND approval.activity_key = activity.activity_key
      LEFT JOIN agent_subagent_calls subagent
        ON activity.kind = 'subagent'
        AND subagent.id = activity.activity_id
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC, activity.sequence ASC
    `).all(windowParameters) as ActivityRow[]

    for (const row of rows) {
      const run = runs.get(row.run_id)
      if (!run) throw new Error(`Activity run ${row.run_id} was not loaded.`)
      if (row.kind === 'tool') {
        run.tools.push({
          ...this.toolPayload(row.run_id,row.activity_id,row.name,row.parent_subagent_id ?? undefined),
          sequence: row.sequence,
          status: row.status,
          ...(row.approval_interrupt_id !== null && row.approval_action_index !== null
            ? {
                approval: {
                  status: 'pending_approval' as const,
                  interruptId: row.approval_interrupt_id,
                  actionIndex: row.approval_action_index
                }
              }
            : {}),
          subagentId: row.parent_subagent_id ?? undefined,
          startedAt: row.started_at,
          completedAt: row.completed_at ?? undefined
        })
      } else {
        const projected = parseSubagentActivityPayload(row.output_json)
        const status = row.subagent_status ?? projected.status
        const result = row.subagent_status
          ? row.subagent_result_text ?? undefined
          : projected.result
        const error = row.subagent_status
          ? row.subagent_error ?? undefined
          : projected.error
        const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
        run.subagents.push({
          id: row.activity_id,
          name: row.subagent_name ?? row.name,
          sequence: row.sequence,
          status,
          parentSubagentId: row.subagent_status
            ? row.subagent_parent_id ?? undefined
            : row.parent_subagent_id ?? undefined,
          ...(result === undefined ? {} : { result }),
          ...(error === undefined ? {} : { error }),
          startedAt: row.started_at,
          completedAt: terminal
            ? row.completed_at ?? row.subagent_updated_at ?? undefined
            : undefined
        })
      }
    }

    const modelRows = this.database.prepare(`
      SELECT
        model.run_id,
        model.model_id,
        message.message_id,
        model.sequence,
        ${modelRoundSql} AS model_round,
        model.subagent_id,
        model.status,
        timing.started_at,
        timing.completed_at
      FROM agent_model_activities model
      INNER JOIN agent_runs run ON run.id = model.run_id
      INNER JOIN json_each(@windows) page_window ON json_extract(page_window.value, '$.runId')=run.id
        AND model.sequence >= json_extract(page_window.value, '$.start')
        AND model.sequence < json_extract(page_window.value, '$.before')
      INNER JOIN agent_activity_timing timing
        ON timing.run_id = model.run_id
        AND timing.activity_key = 'model:' || model.model_id
      LEFT JOIN agent_model_messages message
        ON message.run_id = model.run_id
        AND message.model_id = model.model_id
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC, model.sequence ASC
    `).all(windowParameters) as ModelActivityRow[]
    for (const row of modelRows) {
      const run = runs.get(row.run_id)
      if (!run) throw new Error(`Model activity run ${row.run_id} was not loaded.`)
      run.models.push({
        id: row.model_id,
        messageId: row.message_id ?? undefined,
        sequence: row.sequence,
        status: row.status,
        subagentId: row.subagent_id ?? undefined,
        round: row.model_round,
        ...this.modelPayload(row.run_id,row.model_id,row.message_id ?? undefined,row.subagent_id ?? undefined),
        startedAt: row.started_at,
        completedAt: row.completed_at ?? undefined
      })
    }

    const memoryRecallRows = this.database.prepare(`
      SELECT
        recall.run_id,
        recall.recall_id,
        recall.sequence,
        recall.query,
        recall.prompt_text,
        recall.memory_count,
        recall.agent_name,
        recall.created_at
      FROM agent_memory_recalls recall
      INNER JOIN agent_runs run ON run.id = recall.run_id
      INNER JOIN json_each(@windows) page_window ON json_extract(page_window.value, '$.runId')=run.id
        AND recall.sequence >= json_extract(page_window.value, '$.start')
        AND recall.sequence < json_extract(page_window.value, '$.before')
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC, recall.sequence ASC
    `).all(windowParameters) as MemoryRecallRow[]
    for (const row of memoryRecallRows) {
      const run = runs.get(row.run_id)
      if (!run) throw new Error(`Memory recall run ${row.run_id} was not loaded.`)
      const recalls = run.memoryRecalls ?? []
      recalls.push(memoryRecallFromRow(row))
      run.memoryRecalls = recalls
    }

    const summaryRows = this.database.prepare(`
      SELECT
        summary.run_id,
        summary.summary_id,
        summary.sequence,
        summary.status,
        summary.summary_text,
        summary.model_content,
        summary.committed_checkpoint_id,
        summary.cutoff_index,
        summary.activated_after_message_index,
        summary.covered_through_message_id,
        summary.first_preserved_message_id,
        summary.input_tokens_before,
        summary.input_tokens_after,
        summary.created_at
      FROM agent_context_summaries summary
      INNER JOIN agent_runs run ON run.id = summary.run_id
      INNER JOIN json_each(@windows) page_window ON json_extract(page_window.value, '$.runId')=run.id
        AND summary.sequence >= json_extract(page_window.value, '$.start')
        AND summary.sequence < json_extract(page_window.value, '$.before')
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC, summary.sequence ASC
    `).all(windowParameters) as ContextSummaryRow[]
    for (const row of summaryRows) {
      const run = runs.get(row.run_id)
      if (!run) throw new Error(`Context summary run ${row.run_id} was not loaded.`)
      const summaries = run.summaries ?? []
      summaries.push(contextSummaryFromRow(row))
      run.summaries = summaries
    }
    for (const run of runs.values()) {
      const seeds = [...run.models.flatMap((model) => model.subagentId ? [model.subagentId] : []),
        ...run.tools.flatMap((tool) => tool.subagentId ? [tool.subagentId] : []), ...run.subagents.map((subagent) => subagent.id)]
      const headers = this.database.prepare(`
        WITH RECURSIVE needed(id) AS (
          SELECT value FROM json_each(@seeds)
          UNION
          SELECT activity.activity_id FROM agent_activities activity
          LEFT JOIN agent_subagent_calls call ON call.id=activity.activity_id
          WHERE activity.run_id=@runId AND activity.kind='subagent'
            AND COALESCE(call.status,json_extract(activity.output_json,'$.status')) IN ('running','interrupted')
          UNION
          SELECT COALESCE(call.parent_subagent_id,activity.parent_subagent_id)
          FROM agent_activities activity JOIN needed ON needed.id=activity.activity_id
          LEFT JOIN agent_subagent_calls call ON call.id=activity.activity_id
          WHERE activity.run_id=@runId AND activity.kind='subagent'
            AND COALESCE(call.parent_subagent_id,activity.parent_subagent_id) IS NOT NULL
        )
        SELECT activity.activity_id AS id,COALESCE(call.agent_name,activity.name) AS name,activity.sequence,
          COALESCE(call.status,json_extract(activity.output_json,'$.status')) AS status,
          COALESCE(call.parent_subagent_id,activity.parent_subagent_id) AS parentId,
          timing.started_at AS startedAt,COALESCE(timing.completed_at,call.updated_at) AS completedAt
        FROM agent_activities activity JOIN needed ON needed.id=activity.activity_id
        JOIN agent_activity_timing timing ON timing.run_id=activity.run_id AND timing.activity_key=activity.activity_key
        LEFT JOIN agent_subagent_calls call ON call.id=activity.activity_id
        WHERE activity.run_id=@runId AND activity.kind='subagent'
        ORDER BY activity.sequence
      `).all({ runId: run.runId, seeds: JSON.stringify(seeds) }) as Array<{
        id: string; name: string; sequence: number; status: AgentSubagentActivity['status'];
        parentId: string | null; startedAt: string; completedAt: string | null
      }>
      const selected = new Set(run.subagents.map((subagent) => subagent.id))
      for (const header of headers) if (!selected.has(header.id)) run.subagents.push({
        id: header.id, name: header.name, sequence: header.sequence, status: header.status,
        parentSubagentId: header.parentId ?? undefined, startedAt: header.startedAt,
        completedAt: header.status === 'running' || header.status === 'interrupted' ? undefined : header.completedAt ?? undefined,
        detailsDeferred: true
      })
      run.subagents.sort((left, right) => left.sequence - right.sequence)
    }
    return [...runs.values()]
  }

  finishRun(runId: string, status: Exclude<AgentRunStatus, 'running'>, error?: string): AgentRun {
    this.notifyChanged()
    const existing = this.requireRun(runId)
    if (existing.status !== 'running') {
      throw new Error(`Run ${runId} is already ${existing.status}.`)
    }
    const now = timestamp()
    const threadStatus: AgentThreadStatus =
      status === 'interrupted' ? 'interrupted' :
        status === 'failed' ? 'failed' :
          'idle'
    const finish = this.database.transaction(() => {
      const checkpoint = this.getRunCheckpointState(runId)
      if (
        status === 'completed'
        && (
          !checkpoint.terminalCheckpointId
          || checkpoint.terminalCheckpointId !== checkpoint.lastCommittedCheckpointId
        )
      ) {
        throw new Error(`Run ${runId} has no durable completed lifecycle checkpoint.`)
      }
      if (
        status !== 'completed'
        && checkpoint.terminalCheckpointId
        && checkpoint.terminalCheckpointId === checkpoint.lastCommittedCheckpointId
      ) {
        throw new Error(`Run ${runId} already has a durable completed lifecycle checkpoint.`)
      }
      if (
        status === 'interrupted'
        && !this.hasDurableRootInterrupt(runId)
      ) {
        throw new Error(`Run ${runId} has no durable root framework interrupt.`)
      }
      this.database.prepare(`
        UPDATE agent_runs
        SET status = @status,
            updated_at = @updatedAt,
            error = @error,
            terminal_checkpoint_id = CASE
              WHEN @status = 'completed' THEN terminal_checkpoint_id
              ELSE NULL
            END
        WHERE id = @id
      `).run({
        id: runId,
        status,
        updatedAt: now,
        error: error ?? null
      })
      this.database.prepare(`
        DELETE FROM agent_run_resume_intents
        WHERE run_id = ?
      `).run(runId)
      this.database.prepare(`
        DELETE FROM agent_run_input_intents
        WHERE run_id = ?
      `).run(runId)
      if (status !== 'interrupted') {
        this.reconcileCompletedRun(runId)
        this.retainUncommittedFileEdits(runId)
        this.database.prepare(`
          DELETE FROM agent_effect_journal
          WHERE run_id = ?
        `).run(runId)
        this.database.prepare(`
          INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox (run_id)
          VALUES (?)
        `).run(runId)
        }
      this.database.prepare(`
        UPDATE agent_threads
        SET status = ?, updated_at = ?
        WHERE id = ?
      `).run(threadStatus, now, existing.threadId)
    })
    finish()
    if (status !== 'interrupted') {
      this.releaseTransientRunActivity(runId)
    }
    return this.requireRun(runId)
  }

  private releaseTransientRunActivity(runId: string): void {
    for (const key of this.transientModels.keys()) if ((JSON.parse(key) as string[])[0] === runId) this.transientModels.delete(key)
    for (const key of this.transientTools.keys()) if ((JSON.parse(key) as string[])[0] === runId) this.transientTools.delete(key)
  }

  private readBackgroundCleanup(runId: string): AgentRun['backgroundCleanup'] {
    return this.database.prepare('SELECT status, report FROM agent_run_background_cleanup WHERE run_id = ?')
      .get(runId) as AgentRun['backgroundCleanup']
  }

  updateRunBackgroundCleanup(runId: string, cleanup: NonNullable<AgentRun['backgroundCleanup']>): AgentRun {
    this.requireRun(runId)
    this.database.prepare(`INSERT INTO agent_run_background_cleanup (run_id, status, report) VALUES (?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, report = excluded.report`)
      .run(runId, cleanup.status, cleanup.report)
    this.notifyChanged()
    return this.requireRun(runId)
  }

  resumeRun(runId: string, entries: readonly AgentRunResumeEntry[]): AgentRun {
    const existing = this.requireRun(runId)
    if (existing.status !== 'interrupted') throw new Error(`Run ${runId} is not interrupted.`)
    if (entries.length === 0) {
      throw new Error('A run resume intent must contain at least one interrupt response.')
    }
    const interruptIds = new Set<string>()
    const prepared = entries.map((entry) => {
      if (!entry.interruptId || interruptIds.has(entry.interruptId)) {
        throw new Error('A run resume intent must contain unique interrupt IDs.')
      }
      interruptIds.add(entry.interruptId)
      return {
        runId,
        interruptId: entry.interruptId,
        responseJson: serializeResumeResponse(entry.response)
      }
    })
    const now = timestamp()
    const resume = this.database.transaction(() => {
      this.database.prepare(`
        DELETE FROM agent_run_input_intents
        WHERE run_id = ?
      `).run(runId)
      this.database.prepare(`
        DELETE FROM agent_run_resume_intents
        WHERE run_id = ?
      `).run(runId)
      const insertIntent = this.database.prepare(`
        INSERT INTO agent_run_resume_intents (
          run_id,
          interrupt_id,
          response_json
        ) VALUES (
          @runId,
          @interruptId,
          @responseJson
        )
      `)
      for (const entry of prepared) insertIntent.run(entry)
      this.database.prepare(`
        UPDATE agent_runs
        SET status = 'running',
            updated_at = ?,
            error = NULL,
            terminal_checkpoint_id = NULL,
            last_write_checkpoint_ns = NULL,
            last_write_checkpoint_id = NULL,
            cancellation_requested = 0
        WHERE id = ?
      `).run(now, runId)
      this.database.prepare(`
        DELETE FROM agent_file_edit_cleanup_outbox
        WHERE run_id = ?
      `).run(runId)
      this.database.prepare(`
        UPDATE agent_threads
        SET status = 'running',
            updated_at = ?
        WHERE id = ?
      `).run(now, existing.threadId)
    })
    resume()
    return this.requireRun(runId)
  }

  resumeSubagentRun(input: {
    subagentId: string
    ownerThreadId: string
    childRunId: string
    entries: readonly AgentRunResumeEntry[]
  }): {
    run: AgentRun
    call: AgentSubagentCallRecord
    activity: AgentSubagentActivity
  } {
    const call = this.requireSubagentCall(input.subagentId, input.ownerThreadId)
    if (call.childRunId !== input.childRunId) {
      throw new Error(`Subagent ${input.subagentId} does not own run ${input.childRunId}.`)
    }
    if (call.status !== 'interrupted') {
      throw new Error(`Subagent ${input.subagentId} is not interrupted.`)
    }
    const childRun = this.requireRun(input.childRunId)
    if (childRun.threadId !== call.childThreadId) {
      throw new Error(`Run ${input.childRunId} does not belong to subagent ${input.subagentId}.`)
    }
    if (childRun.status !== 'interrupted') {
      throw new Error(`Run ${input.childRunId} is not interrupted.`)
    }
    return this.database.transaction(() => {
      const run = this.resumeRun(input.childRunId, input.entries)
      const transition = this.markSubagentCallRunning(input.subagentId, input.ownerThreadId)
      if (!transition) {
        throw new Error(`Subagent ${input.subagentId} could not transition to running.`)
      }
      return { run, ...transition }
    })()
  }

  private upsertActivity(activity: {
    runId: string
    key: string
    kind: ActivityRow['kind']
    id: string
    parentSubagentId?: string
    name: string
    status: ActivityRow['status']
    output?: unknown
  }): Pick<AgentToolActivity, 'sequence' | 'startedAt' | 'completedAt'> {
    this.requireRun(activity.runId)
    const sequence = this.nextActivitySequence(activity.runId)
    this.database.prepare(`
      INSERT INTO agent_activities (
        run_id,
        activity_key,
        sequence,
        kind,
        activity_id,
        parent_subagent_id,
        name,
        status,
        output_json
      ) VALUES (
        @runId,
        @key,
        @sequence,
        @kind,
        @id,
        @parentSubagentId,
        @name,
        @status,
        @outputJson
      )
      ON CONFLICT (run_id, activity_key) DO UPDATE SET
        parent_subagent_id = excluded.parent_subagent_id,
        name = excluded.name,
        status = excluded.status,
        output_json = COALESCE(excluded.output_json, agent_activities.output_json)
    `).run({
      ...activity,
      sequence,
      parentSubagentId: activity.parentSubagentId ?? null,
      outputJson: serializeValue(activity.output)
    })
    const existing = this.database.prepare(`
      SELECT sequence
      FROM agent_activities
      WHERE run_id = ? AND activity_key = ?
    `).get(activity.runId, activity.key) as { sequence: number }
    return {
      sequence: existing.sequence,
      ...this.recordActivityTiming(
        activity.runId,
        activity.key,
        activity.status
      )
    }
  }

  private recordActivityTiming(
    runId: string,
    activityKey: string,
    status: 'running' | 'completed'
  ): Pick<AgentToolActivity, 'startedAt' | 'completedAt'> {
    const now = timestamp()
    this.database.prepare(`
      INSERT INTO agent_activity_timing (
        run_id,
        activity_key,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (run_id, activity_key) DO UPDATE SET
        completed_at = CASE
          WHEN excluded.completed_at IS NOT NULL THEN excluded.completed_at
          ELSE agent_activity_timing.completed_at
        END
    `).run(
      runId,
      activityKey,
      now,
      status === 'completed' ? now : null
    )
    const timing = this.database.prepare(`
      SELECT started_at, completed_at
      FROM agent_activity_timing
      WHERE run_id = ? AND activity_key = ?
    `).get(runId, activityKey) as {
      started_at: string
      completed_at: string | null
    }
    return {
      startedAt: timing.started_at,
      completedAt: timing.completed_at ?? undefined
    }
  }

  private nextActivitySequence(runId: string): number {
    const row = this.database.prepare(`
      SELECT MAX(sequence) AS sequence
      FROM (
        SELECT MAX(sequence) AS sequence FROM agent_activities WHERE run_id = ?
        UNION ALL
        SELECT MAX(sequence) AS sequence FROM agent_model_activities WHERE run_id = ?
        UNION ALL
        SELECT MAX(sequence) AS sequence FROM agent_context_summaries WHERE run_id = ?
        UNION ALL
        SELECT MAX(sequence) AS sequence FROM agent_memory_recalls WHERE run_id = ?
      )
    `).get(runId, runId, runId, runId) as { sequence: number | null }
    return (row.sequence ?? -1) + 1
  }

  private stagedContextSummaryRowsForThread(threadId: string): ContextSummaryRow[] {
    return this.database.prepare(`
      SELECT
        summary.run_id,
        summary.summary_id,
        summary.sequence,
        summary.status,
        summary.summary_text,
        summary.model_content,
        summary.committed_checkpoint_id,
        summary.cutoff_index,
        summary.activated_after_message_index,
        summary.covered_through_message_id,
        summary.first_preserved_message_id,
        summary.input_tokens_before,
        summary.input_tokens_after,
        summary.created_at
      FROM agent_context_summaries summary
      INNER JOIN agent_runs run ON run.id = summary.run_id
      WHERE run.thread_id = ?
        AND summary.status = 'running'
        AND summary.committed_checkpoint_id IS NULL
      ORDER BY run.rowid DESC, summary.sequence DESC
    `).all(threadId) as ContextSummaryRow[]
  }

  private storedContextSummaryFromRow(row: ContextSummaryRow): StoredContextSummary {
    if (
      row.status !== 'completed'
      || row.committed_checkpoint_id === null
      || row.cutoff_index === null
      || row.activated_after_message_index === null
    ) {
      throw new Error(`Context summary ${row.summary_id} has not been committed to a checkpoint.`)
    }
    return {
      ...contextSummaryFromRow(row),
      runId: row.run_id,
      modelContent: row.model_content,
      committedCheckpointId: row.committed_checkpoint_id,
      cutoffIndex: row.cutoff_index,
      activatedAfterMessageIndex: row.activated_after_message_index
    }
  }

  private requireContextSummaryRow(runId: string, summaryId: string): ContextSummaryRow {
    const row = this.database.prepare(`
      SELECT
        summary.run_id,
        summary.summary_id,
        summary.sequence,
        summary.status,
        summary.summary_text,
        summary.model_content,
        summary.committed_checkpoint_id,
        summary.cutoff_index,
        summary.activated_after_message_index,
        summary.covered_through_message_id,
        summary.first_preserved_message_id,
        summary.input_tokens_before,
        summary.input_tokens_after,
        summary.created_at
      FROM agent_context_summaries summary
      WHERE summary.run_id = ? AND summary.summary_id = ?
    `).get(runId, summaryId) as ContextSummaryRow | undefined
    if (!row) throw new Error(`Context summary ${summaryId} was not found for run ${runId}.`)
    return row
  }

  private requireContextSummary(runId: string, summaryId: string): AgentContextSummary {
    return contextSummaryFromRow(this.requireContextSummaryRow(runId, summaryId))
  }

  private requireQueuedInput(threadId: string, queuedInputId: string): AgentQueuedInput {
    const queued = this.getQueuedInput(threadId, queuedInputId)
    if (!queued) throw new Error(`Queued input ${queuedInputId} was not found.`)
    return queued
  }

  private queuedInputFromRow(
    row: QueuedInputRow,
    attachments: SelectedAttachment[]
  ): AgentQueuedInput {
    return {
      id: row.id,
      threadId: row.thread_id,
      text: row.text,
      displayText: row.display_text,
      attachments,
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at
    }
  }

  private queuedAttachmentFromRow(row: QueuedAttachmentRow): SelectedAttachment {
    const path = resolve(this.attachmentRoot, row.storage_path)
    const managed = path.startsWith(`${this.attachmentRoot}${sep}`)
    const available = managed && existsSync(path)
    return {
      path: managed ? path : '',
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      kind: row.kind,
      contextPolicy: row.context_policy,
      ...(row.text_truncated === 1 ? { truncated: true } : {}),
      ...(!available ? { skippedReason: 'Queued attachment is no longer available.' } : {})
    }
  }

  private attachmentFromRow(row: AttachmentRow): AgentAttachmentArtifact {
    const path = resolve(this.attachmentRoot, row.storage_path)
    const managed = path.startsWith(`${this.attachmentRoot}${sep}`)
    return {
      id: row.id,
      threadId: row.thread_id,
      messageId: row.message_id,
      runId: row.run_id,
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      kind: row.kind,
      path: managed ? path : '',
      available: managed && existsSync(path),
      textTruncated: row.text_truncated === 1,
      contextPolicy: row.context_policy,
      createdAt: row.created_at
    }
  }

  private attachmentsForThreadDeletion(
    threadId: string
  ): Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>> {
    const attachments = [
      ...this.listAttachmentsForThread(threadId).map(({ id, path }) => ({ id, path }))
    ]
    return [...new Map(attachments.map((attachment) => [attachment.id, attachment])).values()]
  }

  private requireThread(threadId: string): AgentThread {
    const thread = this.getThread(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    return thread
  }

  private requireRun(runId: string): AgentRun {
    const run = this.getRun(runId)
    if (!run) throw new Error(`Run ${runId} was not found.`)
    return run
  }

  private requireManagedCall(callId: string, threadId: string): AgentManagedCallRecord {
    const call = this.getManagedCall(callId, threadId)
    if (!call) throw new Error(`Managed call ${callId} was not found.`)
    return call
  }
}
