import type { DiffContents } from '@shared/diffContents'
import type Database from 'better-sqlite3'
import type { FileChangeQuery, FileChangeQueryResult, FileChangeRoundListInput, FileChangeRoundListResult,
  RoundFileChange, RoundFileChangesInput, RoundFileChangesResult } from '@shared/fileChanges'
import { isDeepStrictEqual } from 'node:util'
import { decodePatchRecord, encodePatchDefinition, encodePatchMetadata, filePatchDefinitionSchema, filePatchRecordMetadataSchema, patchTextHash, validatePatchTransaction, type FilePatchEditRecord } from '../filePatchRecord'
import { projectFileChanges, type FileChangeSource } from './fileChangeProjection'

// Business history, not agent message state. Content-addressed snapshots live
// in the same SQLite transaction as their references, so a database backup is
// sufficient to reconstruct a diff after temporary recovery files are gone.
export const fileChangeLedgerSchema = `
  CREATE TABLE IF NOT EXISTS agent_file_change_revision (
    request_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE CASCADE,
    value INTEGER NOT NULL CHECK (value >= 0)
  );
  CREATE TABLE IF NOT EXISTS agent_file_changes (
    request_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json) AND length(CAST(definition_json AS BLOB)) <= 8000000),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(CAST(metadata_json AS BLOB)) <= 8000000),
    PRIMARY KEY (request_id, operation_id)
  );
  CREATE TABLE IF NOT EXISTS agent_file_change_contents (
    hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
    content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 1000000)
  );
  CREATE TABLE IF NOT EXISTS agent_file_change_content_refs (
    request_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    hash TEXT NOT NULL REFERENCES agent_file_change_contents(hash),
    PRIMARY KEY (request_id, operation_id, hash),
    FOREIGN KEY (request_id, operation_id)
      REFERENCES agent_file_changes(request_id, operation_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS agent_file_change_content_refs_hash_idx
    ON agent_file_change_content_refs(hash);
  CREATE TABLE IF NOT EXISTS agent_file_change_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    entry_index INTEGER NOT NULL CHECK (entry_index >= 0 AND entry_index < 40),
    phase TEXT NOT NULL CHECK (phase IN ('intent', 'applied', 'restore_intent', 'restored')),
    observed INTEGER NOT NULL CHECK (observed IN (0, 1)),
    image_json TEXT CHECK (image_json IS NULL OR json_valid(image_json)),
    UNIQUE (request_id, operation_id, entry_index, phase),
    FOREIGN KEY (request_id, operation_id)
      REFERENCES agent_file_changes(request_id, operation_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS agent_file_change_events_phase_run_idx
    ON agent_file_change_events(phase, request_id);
  CREATE INDEX IF NOT EXISTS agent_message_round_idx
    ON agent_message_index(thread_id, run_id, visible, position);
  CREATE TRIGGER IF NOT EXISTS agent_collect_file_change_content
  AFTER DELETE ON agent_file_change_content_refs
  BEGIN
    DELETE FROM agent_file_change_contents WHERE hash = OLD.hash
      AND NOT EXISTS (SELECT 1 FROM agent_file_change_content_refs WHERE hash = OLD.hash);
  END;
  CREATE TRIGGER IF NOT EXISTS agent_file_change_insert_revision AFTER INSERT ON agent_file_changes
  BEGIN
    INSERT OR IGNORE INTO agent_file_change_revision VALUES (NEW.request_id, 0);
    UPDATE agent_file_change_revision SET value = value + 1 WHERE request_id = NEW.request_id;
  END;
  CREATE TRIGGER IF NOT EXISTS agent_file_change_update_revision AFTER UPDATE ON agent_file_changes
  BEGIN UPDATE agent_file_change_revision SET value = value + 1 WHERE request_id = NEW.request_id; END;
  CREATE TRIGGER IF NOT EXISTS agent_file_change_delete_revision AFTER DELETE ON agent_file_changes
  BEGIN UPDATE agent_file_change_revision SET value = value + 1 WHERE request_id = OLD.request_id; END;
`

interface StoredChange { revision: number; definition_json: string; metadata_json: string }
interface ScopedRun { id: string; thread_id: string; status: string; actor: string; change_revision: number; unsettled: number }
export interface FileChangeEvent {
  sequence: number
  entry_index: number
  phase: 'intent' | 'applied' | 'restore_intent' | 'restored'
  observed: number
  image_json: string | null
}

export class FileChangeLedger {
  constructor(private readonly database: Database.Database, private readonly onChange?: (runId: string) => void) {}

  notifyChanged(runId: string): void { this.onChange?.(runId) }

  listRounds(input: FileChangeRoundListInput): FileChangeRoundListResult {
    const limit = input.limit ?? 20
    if (!input.threadId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 1))
      || (input.selectedRunId !== undefined && (!input.selectedRunId || input.selectedRunId.length > 256))) {
      throw new Error('File change round query exceeds its bounds.')
    }
    return this.database.transaction(() => {
      // Ascend from confirmed writes to their actual parents. A projected child
      // activity in a different run is not an ownership relationship.
      const rows = this.database.prepare(`WITH RECURSIVE changed(id) AS (
        SELECT DISTINCT request_id FROM agent_file_change_events WHERE phase = 'applied'
        UNION SELECT call.parent_run_id FROM agent_subagent_calls call INNER JOIN changed ON call.child_run_id = changed.id
      ) SELECT run.sequence, run.id, run.created_at, run.status FROM agent_runs run
        WHERE run.thread_id = @threadId AND run.operation = 'agent' AND run.id IN (SELECT id FROM changed)
          AND NOT EXISTS (SELECT 1 FROM agent_subagent_calls call WHERE call.child_run_id = run.id)
          AND (@after IS NULL OR run.sequence < @after)
        ORDER BY run.sequence DESC LIMIT @limit`).all({ threadId: input.threadId, after: input.after ?? null, limit: limit + 1 }) as
          Array<{ sequence: number; id: string; created_at: string; status: string }>
      const hasMore = rows.length > limit, selected = rows.slice(0, limit)
      const rounds = selected.map((row) => ({ runId: row.id, createdAt: row.created_at, status: row.status,
        summary: this.roundSummary(input.threadId, row.id) }))
      let selectedRound: FileChangeRoundListResult['selectedRound']
      if (input.selectedRunId !== undefined) {
        selectedRound = rounds.find((round) => round.runId === input.selectedRunId)
        if (!selectedRound) {
          // A valid shortcut may be off this page or have no recorded writes.
          // Resolve it independently so the UI can distinguish it from deletion.
          const row = this.database.prepare(`SELECT id, created_at, status FROM agent_runs run
            WHERE run.id = ? AND run.thread_id = ? AND run.operation = 'agent'
              AND NOT EXISTS (SELECT 1 FROM agent_subagent_calls call WHERE call.child_run_id = run.id)`)
            .get(input.selectedRunId, input.threadId) as { id: string; created_at: string; status: string } | undefined
          selectedRound = row ? { runId: row.id, createdAt: row.created_at, status: row.status,
            summary: this.roundSummary(input.threadId, row.id) } : null
        }
      }
      return { rounds, hasMore, ...(input.selectedRunId !== undefined ? { selectedRound } : {}),
        ...(hasMore ? { nextAfter: selected[selected.length - 1].sequence } : {}) }
    })()
  }

  queryRoundFiles(input: RoundFileChangesInput): RoundFileChangesResult {
    const limit = input.limit ?? 20
    if (!input.runId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || (input.after !== undefined && (!input.after || input.after.length > 32_768))
      || (input.filePath !== undefined && (!input.filePath || input.filePath.length > 32_768))) {
      throw new Error('Round file change query exceeds its bounds.')
    }
    return this.database.transaction(() => {
      const runs = this.runScope(input.runId, 4097)
      if (!runs.length) throw new Error('File change run was not found.')
      if (runs.length > 4096) throw new Error('Round file change scope exceeds 4096 runs.')
      const version = patchTextHash(JSON.stringify(runs))
      if (input.version && input.version !== version) throw new Error('File change history changed; restart pagination.')
      const ids = JSON.stringify(runs.map((run) => run.id)), runMap = new Map(runs.map((run) => [run.id, run]))
      const paths = this.database.prepare(`WITH paths AS (SELECT DISTINCT json_extract(entry.value, '$.before.target.canonicalPath') AS file_path
        FROM agent_file_changes change, json_each(change.definition_json, '$.entries') entry
        WHERE change.request_id IN (SELECT value FROM json_each(@runs))
          AND (json_type(change.metadata_json, '$.transaction.entries[' || entry.key || '].after') = 'object'
            OR json_extract(change.metadata_json, '$.transaction.entries[' || entry.key || '].state') NOT IN ('pending', 'restored')))
        SELECT file_path AS path FROM paths WHERE (@after IS NULL OR file_path > @after) AND (@filePath IS NULL OR file_path = @filePath)
        ORDER BY file_path LIMIT @limit`).all({ runs: ids, after: input.after ?? null, filePath: input.filePath ?? null, limit: limit + 1 }) as Array<{ path: string }>
      const hasMore = paths.length > limit, selected = paths.slice(0, limit).map((row) => row.path)
      // Page FILES, never operations. Every operation for a selected file must
      // participate, including writes far beyond an old operation-page boundary.
      const sources: FileChangeSource[] = []
      let bytes = 0
      const query = this.database.prepare(`SELECT request_id, operation_id, revision, definition_json, metadata_json
        FROM agent_file_changes WHERE request_id IN (SELECT value FROM json_each(@runs))
          AND EXISTS (SELECT 1 FROM json_each(definition_json, '$.entries') entry
            WHERE json_extract(entry.value, '$.before.target.canonicalPath') IN (SELECT value FROM json_each(@paths)))
        ORDER BY rowid`)
      for (const value of query.iterate({ runs: ids, paths: JSON.stringify(selected) })) {
        const row = value as StoredChange & { request_id: string; operation_id: string }
        bytes += Buffer.byteLength(row.definition_json) + Buffer.byteLength(row.metadata_json)
        if (bytes > 32_000_000 || sources.length >= 20_000) throw new Error('Round file change metadata exceeds the query budget; select fewer files.')
        const run = runMap.get(row.request_id)!
        sources.push({ requestId: row.request_id, operationId: row.operation_id, threadId: run.thread_id, actor: run.actor,
          revision: row.revision, definition: row.definition_json, metadata: row.metadata_json,
          contentHashes: (this.database.prepare('SELECT hash FROM agent_file_change_content_refs WHERE request_id = ? AND operation_id = ?')
            .all(row.request_id, row.operation_id) as Array<{ hash: string }>).map((item) => item.hash),
          events: this.events(row.request_id, row.operation_id) })
      }
      const projected = projectFileChanges({ sources, includePatch: false, maxChars: 1, baseDirectory: '', partialPage: false,
        content: () => { throw new Error('Round file listings must not read file bodies.') } })
      const issues = projected.issues.filter((issue) => !issue.path || selected.includes(issue.path))
      const files: RoundFileChange[] = selected.map((path) => {
        const segments = projected.segments.filter((segment) => segment.path === path)
        const first = segments[0], last = segments.at(-1)
        const uncertain = !first || !last || segments.some((segment) => segment.continuity === 'uncertain')
          || issues.some((issue) => !issue.path || issue.path === path)
        // With unknown/overlapping ordering we cannot assert which image is
        // first or last. Keep the file visible, but do not fabricate endpoints.
        if (uncertain) return { path, origins: segments.flatMap((segment) => segment.origins),
          beforeExists: first?.beforeExists ?? false, afterExists: last?.afterExists ?? false,
          continuity: 'uncertain', cancelledOut: false, unavailableReason: 'File change ordering or history is incomplete.' }
        return { path, origins: segments.flatMap((segment) => segment.origins), beforeHash: first.beforeHash, afterHash: last.afterHash,
          beforeExists: first.beforeExists, afterExists: last.afterExists,
          continuity: segments.some((segment) => segment.continuity === 'external_change') ? 'external_change' : 'recorded',
          cancelledOut: segments.length === 1 && first.cancelledOut }
      })
      return { runId: input.runId, version, files, issues,
        pendingRunIds: runs.filter((run) => run.status === 'running' || run.status === 'interrupted' || run.unsettled).map((run) => run.id),
        hasMore, ...(hasMore ? { nextAfter: selected[selected.length - 1] } : {}) }
    })()
  }

  readRoundContent(input: { runId: string; filePath: string; version: string }, target: 'both' | 'before' = 'both'): DiffContents {
    return this.database.transaction((): DiffContents => {
      const page = this.queryRoundFiles(input)
      const file = page.files.find((entry) => entry.path === input.filePath)
      if (!file) throw new Error('Recorded file is no longer in the selected round.')
      if (file.continuity === 'uncertain') return { status: 'unavailable', path: file.path, reason: 'history_missing' }
      try {
        const before = this.readSnapshot(file.beforeHash)
        // Internal composition for a live-disk comparison: the caller replaces
        // the right side. Do not let a missing historical after block that read.
        const after = target === 'before' ? before : this.readSnapshot(file.afterHash)
        if (before.includes('\0') || after.includes('\0')) return { status: 'unavailable', path: file.path, reason: 'binary' }
        return { status: 'ready', path: file.path, before, after, beforeExists: file.beforeExists,
          afterExists: target === 'before' ? file.beforeExists : file.afterExists }
      } catch { return { status: 'unavailable', path: file.path, reason: 'history_missing' } }
    })()
  }

  private runScope(runId: string, limit: number): ScopedRun[] {
    return this.database.prepare(`WITH RECURSIVE scope(id) AS (
      SELECT id FROM agent_runs WHERE id = ?
      UNION SELECT child_run_id FROM agent_subagent_calls call INNER JOIN scope ON call.parent_run_id = scope.id LIMIT ?
    ) SELECT run.id, run.thread_id, run.status, COALESCE(call.agent_name, 'root') AS actor,
      COALESCE(revision.value, 0) AS change_revision,
      (EXISTS (SELECT 1 FROM agent_file_edit_cleanup_outbox cleanup WHERE cleanup.run_id = run.id)
        OR EXISTS (SELECT 1 FROM agent_managed_calls managed WHERE managed.run_id = run.id AND managed.status IN ('preparing', 'running'))) AS unsettled
      FROM scope INNER JOIN agent_runs run ON run.id = scope.id
      LEFT JOIN agent_file_change_revision revision ON revision.request_id = run.id
      LEFT JOIN agent_subagent_calls call ON call.child_run_id = run.id ORDER BY run.id = ? DESC, run.id`)
      .all(runId, limit, runId) as ScopedRun[]
  }

  private roundSummary(threadId: string, runId: string): string {
    // Extract only a short user-facing label. Never hydrate the checkpoint or
    // transfer attachments, tool arguments, or complete message bodies to UI.
    const body = this.database.prepare(`WITH candidate AS (SELECT entry.thread_id, entry.record_id FROM agent_message_index entry
      WHERE entry.thread_id = ? AND entry.run_id = ? AND entry.visible = 1 ORDER BY entry.position LIMIT 1)
      SELECT substr(COALESCE(
      json_extract(CAST(body.value AS TEXT), '$.message.kwargs.additional_kwargs.anas_display_text'),
      CASE json_type(CAST(body.value AS TEXT), '$.message.kwargs.content')
        WHEN 'text' THEN json_extract(CAST(body.value AS TEXT), '$.message.kwargs.content')
        WHEN 'array' THEN (SELECT json_extract(block.value, '$.text')
          FROM json_each(CAST(body.value AS TEXT), '$.message.kwargs.content') block
          WHERE json_extract(block.value, '$.type') = 'text' LIMIT 1) END, ''), 1, 160) AS summary
      FROM candidate JOIN message_bodies body ON body.thread_id = candidate.thread_id AND body.record_id = candidate.record_id
      WHERE body.type = 'json' AND json_extract(CAST(body.value AS TEXT), '$.messageType') = 'human'`)
      .get(threadId, runId) as { summary: string } | undefined
    if (body) return body.summary.replace(/\s+/g, ' ').trim()
    const intent = this.database.prepare(`SELECT substr(COALESCE(json_extract(input_json, '$.displayText'),
      json_extract(input_json, '$.text'), ''), 1, 160) AS summary FROM agent_run_input_intents WHERE run_id = ?`)
      .get(runId) as { summary: string } | undefined
    return intent?.summary.replace(/\s+/g, ' ').trim() ?? ''
  }

  private readSnapshot(hash: string | null | undefined): string {
    if (hash === null) return ''
    if (!hash) throw new Error('Missing snapshot reference.')
    const row = this.database.prepare('SELECT content FROM agent_file_change_contents WHERE hash = ?').get(hash) as { content: string } | undefined
    if (!row || Buffer.byteLength(row.content) > 1_000_000 || patchTextHash(row.content) !== hash) throw new Error('Missing or damaged history.')
    return row.content
  }

  query(input: FileChangeQuery, baseDirectory: string): FileChangeQueryResult {
    if (!input.runId || (input.operationId !== undefined && !input.operationId)) throw new Error('File change query requires exact run/operation IDs.')
    const after = input.after ?? 0, limit = input.limit ?? 20, maxChars = input.maxChars ?? 20_000
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
      || !Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 40_000) throw new Error('File change query exceeds its bounds.')
    return this.database.transaction(() => {
      const runs = this.runScope(input.runId, 257)
      if (!runs.length) throw new Error('File change run was not found.')
      const scopeTruncated = runs.length > 256
      const selected = runs.slice(0, 256), runMap = new Map(selected.map((run) => [run.id, run]))
      const version = patchTextHash(JSON.stringify(selected))
      if (input.version && input.version !== version) throw new Error('File change history changed; restart pagination.')
      const query = this.database.prepare(`SELECT rowid, request_id, operation_id, revision, definition_json, metadata_json
        FROM agent_file_changes WHERE request_id IN (SELECT value FROM json_each(@runs))
        AND rowid > @after AND (@operationId IS NULL OR (request_id = @runId AND operation_id = @operationId))
        AND (@filePath IS NULL OR EXISTS (SELECT 1 FROM json_each(definition_json, '$.entries') entry
          WHERE json_extract(entry.value, '$.before.target.canonicalPath') = @filePath)) ORDER BY rowid LIMIT @limit`)
      const sources: FileChangeSource[] = []
      let hasMore = false, nextAfter = after, bytes = 0
      for (const value of query.iterate({ runs: JSON.stringify(selected.map((run) => run.id)), after,
        operationId: input.operationId ?? null, runId: input.runId, filePath: input.filePath ?? null, limit: limit + 1 })) {
        const row = value as { rowid: number; request_id: string; operation_id: string; revision: number; definition_json: string; metadata_json: string }
        const size = Buffer.byteLength(row.definition_json) + Buffer.byteLength(row.metadata_json)
        if (sources.length >= limit || bytes + size > 16_000_000) { hasMore = true; break }
        bytes += size; nextAfter = row.rowid
        const run = runMap.get(row.request_id)!
        sources.push({ requestId: row.request_id, operationId: row.operation_id, threadId: run.thread_id, actor: run.actor,
          revision: row.revision, contentHashes: (this.database.prepare(`SELECT hash FROM agent_file_change_content_refs WHERE request_id = ? AND operation_id = ?`)
            .all(row.request_id, row.operation_id) as Array<{ hash: string }>).map((item) => item.hash),
          definition: row.definition_json, metadata: row.metadata_json, events: this.events(row.request_id, row.operation_id) })
      }
      if (hasMore && !sources.length) throw new Error('File change metadata exceeds the query budget.')
      if (input.operationId && !sources.length && after === 0) throw new Error('File change operation was not found in the selected run.')
      let contentBytes = 0
      const projected = projectFileChanges({ sources, baseDirectory, maxChars, includePatch: input.includePatch, filePath: input.filePath,
        partialPage: after > 0 || hasMore || scopeTruncated, content: (hash) => {
          if (contentBytes >= 8_000_000) throw new Error('File change content budget exceeded; query one file.')
          const row = this.database.prepare('SELECT content FROM agent_file_change_contents WHERE hash = ?').get(hash) as { content: string } | undefined
          if (!row || patchTextHash(row.content) !== hash || Buffer.byteLength(row.content) > 1_000_000) throw new Error('File change snapshot is missing or damaged.')
          contentBytes += Buffer.byteLength(row.content)
          if (contentBytes > 8_000_000) throw new Error('File change content budget exceeded; query one file.')
          return row.content
        } })
      const pendingRunIds = selected.filter((run) => run.status === 'running' || run.status === 'interrupted' || run.unsettled).map((run) => run.id)
      if (scopeTruncated) projected.issues.push({ runId: input.runId, reason: 'Subagent scope exceeds 256 runs; this view is incomplete.' })
      const complete = !hasMore && after === 0 && !scopeTruncated && pendingRunIds.length === 0 && projected.issues.length === 0
        && !projected.patchTruncated && projected.segments.every((segment) => segment.continuity !== 'uncertain' && !segment.unavailableReason)
      return { scope: 'recorded_run_changes' as const, runId: input.runId, version, operationCount: sources.length, ...projected,
        ...(input.operationId ? { operationId: input.operationId } : {}), ...(input.filePath ? { filePath: input.filePath } : {}),
        pendingRunIds, hasMore, ...(hasMore ? { nextAfter } : {}),
        complete, netDiffAvailable: complete && projected.segments.every((segment) => segment.continuity === 'recorded') }
    })()
  }

  validateIntegrity(): void {
    for (const value of this.database.prepare('SELECT hash, content FROM agent_file_change_contents').iterate()) {
      const row = value as { hash: string; content: string }
      if (Buffer.byteLength(row.content) > 1_000_000 || patchTextHash(row.content) !== row.hash) {
        throw new Error('File change history snapshot is damaged.')
      }
    }
    for (const value of this.database.prepare('SELECT * FROM agent_file_changes').iterate()) {
      const row = value as StoredChange & { request_id: string; operation_id: string }
      const metadata = filePatchRecordMetadataSchema.parse(JSON.parse(row.metadata_json))
      const definition = filePatchDefinitionSchema.parse(JSON.parse(row.definition_json))
      if (metadata.requestId !== row.request_id || metadata.operationId !== row.operation_id || metadata.revision !== row.revision
        || metadata.definitionHash !== patchTextHash(row.definition_json) || metadata.transaction.id !== row.operation_id
        || metadata.transaction.entries.length !== definition.entries.length) throw new Error('File change history identity is invalid.')
      const expected = new Set(definition.entries.flatMap((entry) => [entry.before.hash, entry.afterHash]).filter((hash) => hash !== null))
      const references = this.database.prepare(`SELECT hash FROM agent_file_change_content_refs WHERE request_id = ? AND operation_id = ?`)
        .all(row.request_id, row.operation_id) as Array<{ hash: string }>
      if (references.length !== expected.size || references.some((item) => !expected.has(item.hash))) {
        throw new Error('File change history snapshot references are incomplete.')
      }
    }
  }

  persist(record: FilePatchEditRecord, observed = false): void {
    let changed = false
    validatePatchTransaction(record.transaction)
    const definition = encodePatchDefinition(record.transaction)
    if (patchTextHash(definition) !== record.definitionHash) throw new Error('File change definition hash mismatch.')
    const metadata = encodePatchMetadata(record)
    this.database.transaction(() => {
      const previous = this.row(record.requestId, record.operationId)
      // A later restore may finalize evidence whose originating history was
      // explicitly deleted. Do not resurrect that deleted conversation.
      if (!this.database.prepare('SELECT 1 FROM agent_runs WHERE id = ?').get(record.requestId)) {
        if (observed) return
        throw new Error('File change must belong to an existing run.')
      }
      if (previous) {
        if (previous.definition_json !== definition) throw new Error('File change definition is immutable.')
        if (previous.revision > record.revision) throw new Error('File change history is newer than its recovery evidence.')
        if (previous.revision === record.revision) {
          if (previous.metadata_json !== metadata) throw new Error('File change revision has conflicting evidence.')
          return
        }
        const before = JSON.parse(previous.metadata_json) as { transaction: { entries: Array<{ after: unknown; compensated?: unknown }> } }
        const after = JSON.parse(metadata) as typeof before
        for (const [index, entry] of before.transaction.entries.entries()) {
          if ((entry.after !== null && !isDeepStrictEqual(entry.after, after.transaction.entries[index].after))
            || (entry.compensated !== undefined && !isDeepStrictEqual(entry.compensated, after.transaction.entries[index].compensated))) {
            throw new Error('Confirmed file change evidence is immutable.')
          }
        }
      } else if (!observed && record.transaction.state !== 'prepared') {
        throw new Error('File change preparation must be archived before writes.')
      }
      this.database.prepare(`INSERT INTO agent_file_changes VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (request_id, operation_id) DO UPDATE SET revision = excluded.revision, metadata_json = excluded.metadata_json`)
        .run(record.requestId, record.operationId, record.revision, definition, metadata)
      changed = true
      for (const entry of record.transaction.entries) {
        for (const text of [entry.before.text, entry.afterText]) {
          if (text === null) continue
          const hash = patchTextHash(text)
          this.database.prepare('INSERT OR IGNORE INTO agent_file_change_contents VALUES (?, ?)').run(hash, text)
          const stored = this.database.prepare('SELECT content FROM agent_file_change_contents WHERE hash = ?').get(hash) as { content: string }
          if (stored.content !== text) throw new Error('File change content hash collision or damaged snapshot.')
          this.database.prepare('INSERT OR IGNORE INTO agent_file_change_content_refs VALUES (?, ?, ?)').run(record.requestId, record.operationId, hash)
        }
      }
      const entries = (JSON.parse(metadata) as { transaction: { entries: Array<{ after: unknown; compensated?: unknown }> } }).transaction.entries
      const saveEvent = (index: number, phase: FileChangeEvent['phase'], image: unknown, evidenceOnly = false): void => {
        const imageJson = image === undefined ? null : JSON.stringify(image)
        const existing = this.database.prepare(`SELECT image_json FROM agent_file_change_events
          WHERE request_id = ? AND operation_id = ? AND entry_index = ? AND phase = ?`)
          .get(record.requestId, record.operationId, index, phase) as { image_json: string | null } | undefined
        if (existing) {
          if (existing.image_json !== imageJson) throw new Error('File change event is immutable.')
          return
        }
        this.database.prepare(`INSERT INTO agent_file_change_events
          (request_id, operation_id, entry_index, phase, observed, image_json) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(record.requestId, record.operationId, index, phase, observed || evidenceOnly ? 1 : 0, imageJson)
      }
      record.transaction.entries.forEach((entry, index) => {
        if (entry.state === 'intent') saveEvent(index, 'intent', undefined)
        if (entry.after) saveEvent(index, 'applied', entries[index].after)
        if (entry.state === 'restoring' && entry.after) saveEvent(index, 'restore_intent', undefined)
        // An identical original merely detected during recovery is not a write.
        if (entry.after && entry.compensated && !isDeepStrictEqual(entry.after, entry.compensated)) {
          const intent = this.database.prepare(`SELECT 1 FROM agent_file_change_events
            WHERE request_id = ? AND operation_id = ? AND entry_index = ? AND phase = 'restore_intent' AND observed = 0`)
            .get(record.requestId, record.operationId, index)
          // Without a pre-write boundary this is observed restored state, not
          // proof that the current execution actually performed another write.
          saveEvent(index, 'restored', entries[index].compensated, !intent)
        }
      })
    })()
    if (changed) this.notifyChanged(record.requestId)
  }

  private row(requestId: string, operationId: string): StoredChange | undefined {
    return this.database.prepare(`SELECT revision, definition_json, metadata_json FROM agent_file_changes
      WHERE request_id = ? AND operation_id = ?`).get(requestId, operationId) as StoredChange | undefined
  }

  async load(requestId: string, operationId: string): Promise<FilePatchEditRecord | undefined> {
    const row = this.row(requestId, operationId)
    if (!row) return undefined
    const contents = new Map((this.database.prepare(`SELECT content.hash, content.content FROM agent_file_change_content_refs ref
      INNER JOIN agent_file_change_contents content ON content.hash = ref.hash
      WHERE ref.request_id = ? AND ref.operation_id = ?`).all(requestId, operationId) as Array<{ hash: string; content: string }>).map((item) => [item.hash, item.content]))
    const definition = JSON.parse(row.definition_json) as { entries: Array<{ before: { hash: string | null }; afterHash: string | null }> }
    return decodePatchRecord(JSON.parse(row.metadata_json), row.definition_json, async (index, side) => {
      const hash = side === 'before' ? definition.entries[index].before.hash : definition.entries[index].afterHash
      const content = hash === null ? undefined : contents.get(hash)
      if (content === undefined) throw new Error('File change history snapshot is missing.')
      return content
    })
  }

  events(requestId: string, operationId: string): FileChangeEvent[] {
    return this.database.prepare(`SELECT sequence, entry_index, phase, observed, image_json
      FROM agent_file_change_events WHERE request_id = ? AND operation_id = ? ORDER BY sequence`)
      .all(requestId, operationId) as FileChangeEvent[]
  }
}
