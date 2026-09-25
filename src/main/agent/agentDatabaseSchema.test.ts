import { defaultCapabilities } from '@shared/agentCapabilities'
import Database from 'better-sqlite3'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentDatabase } from './agentDatabase'

describe('current AgentDatabase schema', () => {
  it.each(['running', 'completed', 'unconfirmed'] as const)('persists cleanup %s separately and stops stale progress after reopening', async (status) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-cleanup-report-'))
    const file = join(root, 'agent.sqlite')
    let database: AgentDatabase | undefined
    try {
      database = AgentDatabase.open(file)
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'cleanup-report-run')
      await database.checkpointer.put({ configurable: { thread_id: thread.id, checkpoint_ns: '' } }, {
        v: 4, id: 'cleanup-terminal', ts: new Date().toISOString(),
        channel_values: { anasRunLifecycle: { runId: run.id, status: 'completed' } },
        channel_versions: {}, versions_seen: {}
      }, { source: 'update', step: 0, parents: {} })
      database.finishRun(run.id, 'completed')
      database.updateRunBackgroundCleanup(run.id, { status, report: 'Cleanup detail' })
      expect(database.getRun(run.id)?.error).toBeUndefined()
      expect(database.getActivitiesForThread(thread.id)[0].backgroundCleanup).toEqual({ status, report: 'Cleanup detail' })
      database.close()
      database = AgentDatabase.open(file)
      const cleanup = database.getRun(run.id)?.backgroundCleanup
      expect(cleanup?.status).toBe(status === 'running' ? 'unconfirmed' : status)
      expect(cleanup?.report).toContain('Cleanup detail')
      expect(database.getRun(run.id)?.status).toBe('completed')
      expect(database.getRun(run.id)?.error).toBeUndefined()
    } finally { database?.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([false, true])('freezes coding mode %s across database reopening', async (codingMode) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-coding-snapshot-'))
    const file = join(root, 'agent.sqlite')
    let database: AgentDatabase | undefined
    try {
      database = AgentDatabase.open(file)
      const thread = database.createThread({ title: 'Coding snapshot' })
      const run = database.createRun(thread.id, 'coding-run')
      const configuration = { customTools: [], codingMode, capabilities: structuredClone(defaultCapabilities) }
      database.resolveRunConfiguration(run.id, configuration)
      database.close()
      database = AgentDatabase.open(file)
      expect(database.getRunConfiguration(run.id)).toEqual(configuration)
      expect(() => database!.resolveRunConfiguration(run.id, { ...configuration, codingMode: !codingMode })).toThrow('already fixed')
      const raw = new Database(file, { readonly: true })
      try {
        const row = raw.prepare('SELECT configuration_json FROM agent_runs WHERE id = ?').get(run.id) as { configuration_json: string }
        expect(JSON.parse(row.configuration_json)).toMatchObject({ coding_mode: codingMode })
        expect(JSON.parse(row.configuration_json)).not.toHaveProperty('codingMode')
      } finally { raw.close() }
    } finally { database?.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([
    ['agent_runs', 'error'],
    ['agent_threads', 'title'],
    ['current_state', 'metadata'],
    ['pending_writes', 'value'],
    ['message_bodies', 'value']
  ])('detects a renamed required field %s.%s without modifying the inspected database', async (table, column) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-required-schema-'))
    const file = join(root, 'agent.sqlite')
    const attachments = join(root, 'attachments')
    try {
      AgentDatabase.open(file, attachments).close()
      const raw = new Database(file)
      try { raw.exec(`ALTER TABLE ${table} RENAME COLUMN ${column} TO broken_${column}`) } finally { raw.close() }
      const before = await readFile(file)
      expect(() => AgentDatabase.validateBackup(file, attachments, new Set())).toThrow(`missing column ${table}.${column}`)
      expect(await readFile(file)).toEqual(before)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('detects a missing framework table and accepts an intact current database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-required-tables-'))
    const file = join(root, 'agent.sqlite')
    const attachments = join(root, 'attachments')
    try {
      AgentDatabase.open(file, attachments).close()
      expect(() => AgentDatabase.validateBackup(file, attachments, new Set())).not.toThrow()
      const raw = new Database(file)
      try { raw.exec('DROP TABLE pending_writes') } finally { raw.close() }
      expect(() => AgentDatabase.validateBackup(file, attachments, new Set())).toThrow('missing table pending_writes')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a required column with the wrong type without rebuilding the inspected table', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-column-type-'))
    const file = join(root, 'agent.sqlite')
    const attachments = join(root, 'attachments')
    try {
      AgentDatabase.open(file, attachments).close()
      const raw = new Database(file)
      try {
        const { sql } = raw.prepare("SELECT sql FROM sqlite_schema WHERE name = 'pending_writes'").get() as { sql: string }
        raw.exec('DROP TABLE pending_writes')
        raw.exec(sql.replace('value BLOB', 'value TEXT'))
      } finally { raw.close() }
      const before = await readFile(file)
      expect(() => AgentDatabase.validateBackup(file, attachments, new Set())).toThrow('invalid column definition pending_writes.value')
      expect(await readFile(file)).toEqual(before)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each([true, false])('persists and freezes a resolved background setting of %s', async (enabled) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-agent-run-setting-'))
    const file = join(root, 'agent.sqlite')
    let current: AgentDatabase | undefined
    try {
      current = AgentDatabase.open(file)
      const thread = current.createThread({ title: 'Durable run setting' })
      const run = current.createRun(thread.id, 'durable-setting-run')
      expect(current.getRunConfiguration(run.id)?.capabilities.backgroundTools).toBeUndefined()
      current.resolveRunConfiguration(run.id, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: enabled } })
      current.resolveRunConfiguration(run.id, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: enabled } })
      expect(() => current!.resolveRunConfiguration(run.id, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: !enabled } })).toThrow('already fixed')
      expect(current.getRunConfiguration(run.id)?.capabilities.backgroundTools).toBe(enabled)
      current.close()
      current = AgentDatabase.open(file)
      expect(current.getRunConfiguration(run.id)?.capabilities.backgroundTools).toBe(enabled)
      expect(() => current!.resolveRunConfiguration(run.id, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: !enabled } })).toThrow('already fixed')
      expect(() => current!.resolveRunConfiguration('missing-run', { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: enabled } })).toThrow('was not found')
    } finally {
      current?.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([2, 99])('rejects unsupported schema %i without modifying its data', async (version) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-agent-schema-'))
    const file = join(root, 'agent.sqlite')
    try {
      const current = AgentDatabase.open(file)
      const thread = current.createThread({ title: 'Preserve this data' })
      current.close()
      const fixture = new Database(file)
      fixture.pragma(`user_version = ${version}`)
      fixture.close()
      expect(() => AgentDatabase.open(file)).toThrow(`Unsupported agent database schema ${version}; expected 1.`)
      const verified = new Database(file, { readonly: true })
      try {
        expect(verified.pragma('user_version', { simple: true })).toBe(version)
        expect(verified.prepare('SELECT title FROM agent_threads WHERE id = ?').get(thread.id))
          .toEqual({ title: 'Preserve this data' })
      } finally { verified.close() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
