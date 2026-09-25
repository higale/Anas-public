const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')
const { monacoState } = require('./electron-diff-view.cjs')
const { restrict_subagents, ...capabilities } = require('../data/config/capabilities.json')

// The historical ledger responses are controlled fixtures. Current contents are
// read from real temporary files; this exercises renderer/preload/IPC contracts
// and Monaco, while ledger aggregation and ownership have their own unit tests.
async function installRoundChangesFixture(application, directory) {
  await mkdir(directory, { recursive: true })
  const paths = [join(directory, 'greeting.ts'), join(directory, '子任务.txt')]
  await writeFile(paths[0], 'export const greeting = "current on disk"\n')
  await writeFile(paths[1], 'Child result with a later manual edit\n')
  const page = await application.firstWindow()
  await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
  const modelConfigId = await page.evaluate(async () => {
    const api = globalThis.gale.config
    const available = (await api.get()).providers.flatMap((provider) => provider.models).find((model) => model.capabilities.toolUse)
    if (available) return available.id
    const added = await api.saveModelProvider({ name: 'Round review fixture', protocol: 'openai_chat_completions',
      baseUrl: 'https://round-review.invalid/v1', apiKey: '', parameters: {}, modelListAuth: 'bearer' })
    const providerId = added.providers.find((provider) => provider.name === 'Round review fixture').id
    const configured = await api.saveProviderModel({ providerId, displayName: 'Round review model', model: 'round-review', parameters: {},
      parameterPresetMode: 'custom', parameterPresets: [], capabilities: { vision: false, toolUse: true }, stream: true,
      maxContextTokens: 128000, maxOutputTokens: 16000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
    const id = configured.providers.find((provider) => provider.id === providerId).models[0].id
    await api.selectDefaultModel(id)
    return id
  })
  await application.evaluate(({ ipcMain }, { paths, modelConfigId }) => {
    const now = new Date().toISOString(), older = '2026-09-01T00:00:00.000Z'
    const thread = { id: 'changes-review', projectId: 'default-workspace', modelConfigId, title: 'Recorded changes',
      status: 'idle', accessMode: 'read_only_allowed', pinned: false, userTurnCount: 2, createdAt: older, updatedAt: now }
    const rounds = [
      { runId: 'changes-run-new', createdAt: now, summary: 'Update greeting with child help', status: 'completed' },
      { runId: 'changes-run-old', createdAt: older, summary: 'Create the first greeting', status: 'completed' }
    ]
    const bodies = {
      'changes-run-new': [
        ['export const greeting = "before"\n', 'export const greeting = "recorded result"\n'],
        ['Child original\n', 'Child recorded result\n']
      ],
      'changes-run-old': [['export const greeting = "initial"\n', 'export const greeting = "before"\n']]
    }
    const versionFor = (runId) => (runId === 'changes-run-new' ? 'b' : 'a').repeat(64)
    const snapshot = { thread, messages: rounds.slice().reverse().map((round) => ({ id: `${round.runId}-answer`, role: 'assistant', runId: round.runId,
      content: [{ type: 'text', text: round.summary }] })), todos: [], interrupts: [],
      activities: [{ runId: rounds[0].runId, operation: 'agent', status: 'completed', createdAt: now, updatedAt: now, models: [], tools: [],
        subagents: [{ id: 'fixture-child', name: 'Fixture child', sequence: 1, status: 'completed', result: 'Child recorded result' }] }],
      messageWindow: { startIndex: 0, shown: 2, total: 2, remaining: 0 } }
    const probe = globalThis.__anasRoundProbe = { contents: [], files: [], rounds: [], submission: undefined }
    for (const [channel, handler] of [
      ['agent:threads:list', () => [thread]], ['agent:threads:get', () => snapshot],
      ['agent:workspace:get', () => ({ mode: 'thread', threadId: thread.id })],
      ['agent:runs:recover', (_event, threadId) => {
        if (threadId !== thread.id) throw new Error('Unexpected conversation in fixture recovery')
        return false
      }],
      ['agent:changes:rounds', (_event, input) => {
        if (input.threadId !== thread.id) throw new Error('Unexpected conversation in round list')
        probe.rounds.push(input)
        return { rounds, hasMore: false,
          ...(input.selectedRunId ? { selectedRound: rounds.find((round) => round.runId === input.selectedRunId) ?? null } : {}) }
      }],
      ['agent:changes:roundFiles', (_event, input) => {
        if (input.threadId !== thread.id || !bodies[input.runId]) throw new Error('Unexpected round file scope')
        probe.files.push(input)
        return { runId: input.runId, version: versionFor(input.runId), pendingRunIds: [], issues: [], hasMore: false,
          files: bodies[input.runId].map((_body, index) => ({ path: paths[index], beforeExists: true, afterExists: true,
            continuity: 'recorded', cancelledOut: false, origins: [{ runId: index ? 'changes-child-run' : input.runId,
              threadId: index ? 'changes-child-thread' : thread.id, actor: index ? 'fixture-child' : 'root',
              operationId: `edit-${index}`, entryIndex: 0, direction: 'forward' }] })) }
      }],
      ['agent:changes:roundContents', async (_event, input) => {
        if (input.threadId !== thread.id || input.version !== versionFor(input.runId)) throw new Error('Unexpected round content scope')
        const index = paths.indexOf(input.filePath), body = bodies[input.runId]?.[index]
        if (!body) throw new Error('Unknown round file')
        probe.contents.push(input)
        const after = input.target === 'current' ? await process.getBuiltinModule('node:fs/promises').readFile(input.filePath, 'utf8') : body[1]
        return { status: 'ready', path: input.filePath, beforeExists: true, afterExists: true, before: body[0], after }
      }],
      ['agent:runs:submit', (_event, input) => {
        probe.submission = input
        return { thread, run: { id: 'round-review-run', threadId: thread.id, operation: 'agent', status: 'completed', createdAt: now, updatedAt: now } }
      }]
    ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
  }, { paths, modelConfigId })
  return paths
}

async function verifyRoundChangesInApplication(application, directory, { nonGit = false } = {}) {
  const paths = await installRoundChangesFixture(application, directory)
  const page = await application.firstWindow()
  await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
  await page.reload()
  await expect(page.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 45000 })
  await page.getByRole('button', { name: 'File changes', exact: true }).click()
  const panel = page.getByRole('tabpanel')
  if (nonGit) await expect(panel).toContainText('This folder is not a Git working tree.')
  await panel.getByRole('button', { name: 'Comparison', exact: true }).click()
  await page.getByRole('menuitemradio', { name: 'Run changes', exact: true }).click()
  const runs = panel.getByRole('combobox', { name: 'Select run', exact: true })
  const current = panel.getByRole('checkbox', { name: 'Compare with current file', exact: true })
  await expect(runs).toHaveValue(/Update greeting with child help/)
  await runs.click()
  const options = page.getByRole('listbox').getByRole('option')
  await expect(options).toHaveCount(2)
  const labels = await options.allTextContents()
  assert.match(labels[0], /Update greeting with child help/, 'Recent changed runs must appear newest first.')
  assert.match(labels[1], /Create the first greeting/)
  await page.keyboard.press('Escape')
  await expect(current).not.toBeChecked()
  await expect(panel.locator('.ui-diff-file')).toHaveCount(2)
  await expect(panel.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20000 })
  await expect.poll(async () => (await monacoState(application, page)).models).toEqual([
    'export const greeting = "before"\n', 'export const greeting = "recorded result"\n'
  ])
  const sideBySide = panel.getByRole('button', { name: 'Side by side', exact: true })
  const fold = panel.getByRole('button', { name: 'Fold unchanged regions', exact: true })
  const wrap = panel.getByRole('button', { name: 'Word wrap', exact: true })
  await sideBySide.click()
  if (await fold.getAttribute('aria-pressed') === 'true') await fold.click()
  if (await wrap.getAttribute('aria-pressed') !== 'true') await wrap.click()
  const toolbar = await Promise.all([sideBySide, fold, wrap].map((button) => button.elementHandle()))
  const expectPreferences = async () => {
    await expect(current).toBeChecked()
    await expect(sideBySide).toHaveAttribute('aria-pressed', 'true')
    await expect(fold).toHaveAttribute('aria-pressed', 'false')
    await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    for (const control of toolbar) assert.ok(await control.evaluate((element) => element.isConnected), 'Changing round or target must keep the shared toolbar mounted.')
  }
  await current.check()
  await expect.poll(async () => (await monacoState(application, page)).models).toEqual([
    'export const greeting = "before"\n', 'export const greeting = "current on disk"\n'
  ])
  await panel.locator('.ui-diff-file').filter({ hasText: paths[1] }).click()
  await expect.poll(async () => (await monacoState(application, page)).models).toEqual([
    'Child original\n', 'Child result with a later manual edit\n'
  ])
  await expectPreferences()
  await runs.click()
  await page.getByRole('option', { name: /Create the first greeting/ }).click()
  await expect(panel.locator('.ui-diff-file')).toHaveCount(1)
  await expect.poll(async () => (await monacoState(application, page)).models).toEqual([
    'export const greeting = "initial"\n', 'export const greeting = "current on disk"\n'
  ])
  await expectPreferences()
  await writeFile(paths[0], 'export const greeting = "edited after opening"\n')
  await panel.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(async () => (await monacoState(application, page)).models).toContain('export const greeting = "edited after opening"\n')
  const shortcuts = page.getByRole('button', { name: 'Run changes', exact: true })
  await shortcuts.last().click()
  await expect(page.getByRole('tablist').getByRole('tab')).toHaveCount(1)
  await expect(runs).toHaveValue(/Update greeting with child help/)
  await expectPreferences()
  await shortcuts.first().click()
  await expect(runs).toHaveValue(/Create the first greeting/)
  await expect(page.getByRole('tablist').getByRole('tab')).toHaveCount(1)
  await expectPreferences()
  await panel.getByRole('button', { name: 'Review selected scope', exact: true }).click()
  try {
    await expect.poll(() => application.evaluate(() => globalThis.__anasRoundProbe.submission?.review?.target)).toBe('current')
  } catch (error) {
    console.error('Round review diagnostics:', await page.locator('body').innerText())
    if (process.env.ANAS_E2E_ROUND_CHANGES_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_ROUND_CHANGES_SCREENSHOT })
    throw error
  }
  const review = await application.evaluate(() => globalThis.__anasRoundProbe.submission.review)
  assert.equal(review.kind, 'recorded')
  assert.equal(review.threadId, 'changes-review')
  assert.equal(review.runId, 'changes-run-old')
  await current.uncheck()
  await expect.poll(async () => (await monacoState(application, page)).models).toEqual([
    'export const greeting = "initial"\n', 'export const greeting = "before"\n'
  ])
  await application.evaluate(() => { globalThis.__anasRoundProbe.submission = undefined })
  await panel.getByRole('button', { name: 'Review selected scope', exact: true }).click()
  await expect.poll(() => application.evaluate(() => globalThis.__anasRoundProbe.submission?.review?.target)).toBe('recorded')
  await shortcuts.last().click()
  await expect(runs).toHaveValue(/Update greeting with child help/)
  await expect(panel.getByRole('alert')).toHaveCount(0)
  if (process.env.ANAS_E2E_ROUND_CHANGES_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_ROUND_CHANGES_SCREENSHOT })
  return paths
}

async function verifyRoundChanges(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-round-changes-e2e-'))
  let application
  try {
    const workspace = join(home, 'workspace'), now = new Date().toISOString()
    await mkdir(workspace)
    await writeFile(join(home, 'projects.json'), JSON.stringify({ version: 4, projects: [{
      id: 'default-workspace', kind: 'workspace', name: 'Round changes fixture', sourceFolders: [workspace],
      capabilities, restrict_subagents, advanced_settings: false, coding_mode: false,
      pinned: false, collapsed: false, prompt: '', createdAt: now, updatedAt: now
    }] }))
    application = await launchApplication(home)
    const page = await application.firstWindow(), pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.locator('[data-agent-composer-input]').waitFor({ timeout: 45000 })
    await verifyRoundChangesInApplication(application, join(home, 'files'), { nonGit: true })
    assert.deepEqual(pageErrors, [])
    console.log('Round changes Electron E2E passed: non-Git access, recent round selection, child file display, actual current disk reads, persistent controls, one shared tab, and matching review targets (controlled ledger IPC fixtures).')
  } finally {
    await application?.close().catch(() => {})
    await rm(home, { recursive: true, force: true })
  }
}

module.exports = { verifyRoundChanges, verifyRoundChangesInApplication }
