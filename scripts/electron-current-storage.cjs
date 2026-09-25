const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join, resolve } = require('node:path')
const { _electron: electron } = require('playwright')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

// Test-only wrapper exposes the actual built module's storage objects. All
// renderer reads keep their real preload/IPC/runtime/database implementations.
async function verifyCurrentStorage(repositoryRoot, executablePath) {
  const root = await mkdtemp(join(tmpdir(), 'anas-current-storage-e2e-'))
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('anas-current-storage-e2e-')) throw new Error('Unexpected storage test directory.')
  const count = Number(process.env.ANAS_E2E_STORAGE_MESSAGES || 1000)
  assert.ok(Number.isSafeInteger(count) && count >= 1000 && count <= 10000)
  let application
  let phase = 'launch'
  try {
    const documents = join(root, 'documents')
    await mkdir(documents)
    await symlink(join(repositoryRoot, 'data'), join(root, 'data'), 'junction')
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'anas-current-storage-test', version: '1.0.0', main: 'main.cjs' }))
    await writeFile(join(root, 'main.cjs'), `
      const { app, ipcMain } = require('electron')
      const Module = require('node:module')
      const nativeRequire = Module.createRequire(${JSON.stringify(join(repositoryRoot, 'package.json'))})
      app.setPath('documents', ${JSON.stringify(documents)})
      const compiledRoot = ${JSON.stringify(join(repositoryRoot, 'out', 'main'))}
      const originalCompile = Module.prototype._compile
      Module.prototype._compile = function(content, filename) {
        if (filename.startsWith(compiledRoot) && content.includes('function currentStorage()')) {
          content += '\\n;globalThis.__anasStorageAccess = { currentStorage, currentDatabase };'
        }
        return originalCompile.call(this, content, filename)
      }
      globalThis.__anasStorageProbe = { snapshots: [], activityPages: [], nativeRequire }
      const originalHandle = ipcMain.handle.bind(ipcMain)
      ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => {
        const started = performance.now()
        try {
          const value = await handler(...args)
          if (channel === 'agent:activities:loadEarlier') globalThis.__anasStorageProbe.activityPages.push({
            beforeSequence: args[1].beforeSequence, startSequence: value.activityWindow.startSequence,
            count: value.models.length + value.tools.length + value.subagents.length + (value.summaries?.length || 0) + (value.memoryRecalls?.length || 0)
          })
          return value
        }
        finally {
          if (channel === 'agent:threads:get') globalThis.__anasStorageProbe.snapshots.push(performance.now() - started)
        }
      })
      require(${JSON.stringify(join(repositoryRoot, 'out', 'main', 'index.js'))})
      Module.prototype._compile = originalCompile
    `)
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_RENDERER_URL
    application = await electron.launch({
      executablePath,
      args: [root, '--data-dir', join(root, 'profile'), ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [])],
      cwd: repositoryRoot, env: environment, timeout: 45000
    })
    application.process().stderr.on('data', (chunk) => {
      if (/Error|error|failed/i.test(String(chunk))) console.error(String(chunk).trim())
    })
    const page = await application.firstWindow({ timeout: 45000 })
    const pageErrors = []
    page.on('pageerror', (error) => pageErrors.push(String(error)))
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 15000 })
    phase = 'seed complete native messages'
    const seeded = await application.evaluate(async (_electron, count) => {
      const { currentStorage } = globalThis.__anasStorageAccess || {}
      if (!currentStorage) throw new Error('The built main module did not expose current storage; rebuild the current tree.')
      const probe = globalThis.__anasStorageProbe
      const { HumanMessage, AIMessage } = probe.nativeRequire('@langchain/core/messages')
      const { emptyCheckpoint } = probe.nativeRequire('@langchain/langgraph-checkpoint')
      const storage = currentStorage()
      const started = performance.now()
      const threads = []
      const runs = []
      for (const [title, length] of [['Storage long conversation', count], ['Storage short conversation', 2]]) {
        const thread = storage.createThread({ title })
        const database = storage.conversationForThread(thread.id)
        if (typeof database.checkpointer.saveReferencedValue !== 'function') throw new Error('Expected the current normalized Saver in the built app.')
        const run = database.createRun(thread.id)
        database.checkpointer.retainRun(run.id, thread.id)
        const messages = Array.from({ length }, (_, index) => {
          const fields = { id: `${thread.id}:seed:${index}`, content: `Storage fixture ${index}. ${'x'.repeat(768)}`,
            additional_kwargs: { anas_run_id: run.id } }
          return index % 2 ? new AIMessage(fields) : new HumanMessage(fields)
        })
        const checkpoint = emptyCheckpoint()
        checkpoint.channel_values = { messages, anasRunLifecycle: { runId: run.id, status: 'completed' } }
        checkpoint.channel_versions = { messages: 1, anasRunLifecycle: 1 }
        await database.checkpointer.put({ configurable: { thread_id: thread.id } }, checkpoint, { source: 'loop', step: 0, parents: {} })
        database.finishRun(run.id, 'completed')
        await database.checkpointer.releaseRun(run.id)
        storage.refreshConversation(thread.id)
        threads.push(thread.id)
        runs.push(run)
      }
      probe.threads = threads
      probe.runs = runs
      return { threads, seedMs: performance.now() - started }
    }, count)
    phase = 'load real conversation snapshot'
    await page.reload()
    const longThread = page.locator('.thread-open').filter({ hasText: 'Storage long conversation' })
    const shortThread = page.locator('.thread-open').filter({ hasText: 'Storage short conversation' })
    await expect(longThread).toBeVisible()
    await longThread.click()
    await expect(page.locator('.topbar')).toContainText('Storage long conversation')
    const initialSnapshot = await page.evaluate((id) => globalThis.gale.agent.threads.get(id), seeded.threads[0])
    assert.equal(initialSnapshot.messageWindow.total, count)
    assert.ok(initialSnapshot.messages.length < count, 'The UI snapshot must page the real database, not load the entire conversation.')
    const initialActivity = initialSnapshot.activities[0]
    assert.ok(initialActivity.activityWindow.hasEarlier)
    assert.equal(initialActivity.models.length, 100, 'Only the latest 100 complete model activities should be decoded initially.')
    const expandActivities = async () => {
      const toggle = page.locator('.agent-activity-range-toggle[aria-expanded="false"]').first()
      if (await toggle.count()) await toggle.click()
    }
    await expandActivities()
    const initialVisibleActivities = await page.locator('.agent-activity-model').count()
    await page.getByRole('button', { name: /^(加载更早活动|Load earlier activities)$/ }).click()
    await expect.poll(() => page.locator('.agent-activity-model').count()).toBeGreaterThan(initialVisibleActivities)
    const expandedActivityCount = await page.locator('.agent-activity-model').count()
    const pages = await application.evaluate(() => globalThis.__anasStorageProbe.activityPages)
    assert.equal(pages.length, 1, 'The real earlier-activities IPC must service the UI request.')
    assert.equal(pages[0].count, 100)
    assert.equal(pages[0].beforeSequence, initialActivity.activityWindow.startSequence)
    assert.ok(pages[0].startSequence < pages[0].beforeSequence)

    await page.evaluate(() => {
      const probe = globalThis.__anasStorageFrames = { gaps: [], last: performance.now(), running: true }
      const frame = (now) => { probe.gaps.push(now - probe.last); probe.last = now; if (probe.running) globalThis.requestAnimationFrame(frame) }
      globalThis.requestAnimationFrame(frame)
    })
    await application.evaluate(() => {
      const probe = globalThis.__anasStorageProbe
      const { currentDatabase } = globalThis.__anasStorageAccess
      const { AIMessage } = probe.nativeRequire('@langchain/core/messages')
      const { emptyCheckpoint } = probe.nativeRequire('@langchain/langgraph-checkpoint')
      probe.stop = false
      probe.completed = false
      probe.appendMs = []
      probe.delays = []
      probe.snapshots = []
      let last = performance.now()
      const monitor = setInterval(() => { const now = performance.now(); probe.delays.push(Math.max(0, now - last - 10)); last = now }, 10)
      probe.job = (async () => {
        const database = currentDatabase(probe.threads[0])
        // This is a persistence workload, not a recoverable model execution.
        // Keep the seeded product run terminal so a real UI read cannot start
        // a model provider while the probe writes its completed native items.
        const run = probe.runs[0]
        const retentionId = `${run.id}:storage-probe`
        database.checkpointer.retainRun(retentionId, run.threadId)
        try {
          const started = performance.now()
          let tuple = await database.checkpointer.getTuple({ configurable: { thread_id: run.threadId } })
          probe.hydrateMs = performance.now() - started
          let messages = tuple.checkpoint.channel_values.messages
          for (let index = 0; index < 500 && (!probe.stop || index < 10); index += 1) {
            const appendStarted = performance.now()
            const message = new AIMessage({ id: `${run.id}:${index}`, content: `Live complete result ${index}. ${'y'.repeat(2048)}`,
              additional_kwargs: { anas_run_id: run.id } })
            await database.checkpointer.putWrites(tuple.config, [['messages', [message]]], `task-${index}`)
            messages = [...messages, message]
            const checkpoint = emptyCheckpoint()
            checkpoint.channel_values = { messages, anasRunLifecycle: { runId: run.id, status: 'completed' } }
            checkpoint.channel_versions = { messages: index + 2, anasRunLifecycle: index + 2 }
            const config = await database.checkpointer.put(tuple.config, checkpoint, { source: 'loop', step: index + 1, parents: {} })
            tuple = { config, checkpoint }
            probe.appendMs.push(performance.now() - appendStarted)
            await new Promise((resolve) => setTimeout(resolve, 25))
          }
          const checkpoint = emptyCheckpoint()
          checkpoint.channel_values = { messages, anasRunLifecycle: { runId: run.id, status: 'completed' } }
          checkpoint.channel_versions = { messages: 10000, anasRunLifecycle: 10000 }
          await database.checkpointer.put(tuple.config, checkpoint, { source: 'loop', step: 10000, parents: {} })
          probe.finalCount = database.checkpointer.countMessages(run.threadId)
        } catch (error) { probe.error = String(error); throw error }
        finally {
          await database.checkpointer.releaseRun(retentionId)
          clearInterval(monitor)
          probe.completed = true
        }
      })()
      probe.job.catch(() => undefined)
    })

    phase = 'interact during current state writes'
    const interactionMs = []
    for (const [width, height] of [[1120, 820], [1380, 950]]) {
      assert.equal(await application.evaluate(() => globalThis.__anasStorageProbe.completed), false, 'Storage writes must still be active during interactions.')
      const started = performance.now()
      await application.evaluate(({ BrowserWindow }, size) => { const window = BrowserWindow.getAllWindows()[0]; window.unmaximize(); window.setContentSize(...size) }, [width, height])
      await expect.poll(() => page.evaluate(() => Math.round(globalThis.document.querySelector('.app-shell').getBoundingClientRect().width)), { timeout: 3000 }).toBe(width)
      await expect.poll(() => page.evaluate(() => Math.round(globalThis.document.querySelector('.app-shell').getBoundingClientRect().height)), { timeout: 3000 }).toBe(height)
      await page.locator('.sidebar-collapse').click()
      await expect(page.locator('.app-shell')).toHaveClass(/sidebar-collapsed/)
      await page.locator('.topbar-sidebar-toggle').click()
      await expect(page.locator('.app-shell')).not.toHaveClass(/sidebar-collapsed/)
      await shortThread.click()
      await expect(page.locator('.topbar')).toContainText('Storage short conversation')
      await expect(page.locator('.message-sequence')).toHaveCount(2)
      await longThread.click()
      await expect(page.locator('.topbar')).toContainText('Storage long conversation')
      await expandActivities()
      await expect.poll(() => page.locator('.agent-activity-model').count()).toBeGreaterThanOrEqual(expandedActivityCount)
      const snapshot = await page.evaluate((id) => globalThis.gale.agent.threads.get(id), seeded.threads[0])
      assert.ok(snapshot.messageWindow.total > count)
      assert.ok(snapshot.messages.length < count)
      interactionMs.push(performance.now() - started)
    }
    await application.evaluate(async () => { globalThis.__anasStorageProbe.stop = true; await globalThis.__anasStorageProbe.job })
    const result = await application.evaluate(() => {
      const probe = globalThis.__anasStorageProbe
      const max = (values) => Math.max(0, ...values)
      return { hydrateMs: probe.hydrateMs, appendCount: probe.appendMs.length, appendMaxMs: max(probe.appendMs),
        mainDelayMaxMs: max(probe.delays), snapshotMaxMs: max(probe.snapshots), finalCount: probe.finalCount,
        activityPages: probe.activityPages, error: probe.error }
    })
    const frameMaxMs = await page.evaluate(() => { const probe = globalThis.__anasStorageFrames; probe.running = false; return Math.max(0, ...probe.gaps) })
    assert.equal(result.error, undefined)
    assert.equal(result.finalCount, count + result.appendCount)
    assert.ok(result.appendCount >= 10)
    assert.ok(result.mainDelayMaxMs < 500, `Main process blocked for ${result.mainDelayMaxMs.toFixed(1)} ms.`)
    assert.ok(result.snapshotMaxMs < 1500, `Real snapshot IPC took ${result.snapshotMaxMs.toFixed(1)} ms.`)
    assert.ok(frameMaxMs < 1500, `Renderer frame stalled for ${frameMaxMs.toFixed(1)} ms.`)
    assert.deepEqual(pageErrors, [])
    await expect(page.locator('.thread-title.error, .agent-activity-error')).toHaveCount(0)
    await page.screenshot({ path: process.env.ANAS_E2E_STORAGE_SCREENSHOT || join(tmpdir(), 'anas-current-storage.png') })
    console.log(`Current storage Electron E2E passed: ${JSON.stringify({ messages: count, seedMs: seeded.seedMs, ...result, frameMaxMs, interactionMs })}`)
  } catch (error) {
    console.error(`Current storage E2E failed during ${phase}:`, error)
    throw error
  } finally {
    await closeElectronTestApplication(application, () => application.evaluate(async () => {
      const probe = globalThis.__anasStorageProbe
      if (probe?.job) { probe.stop = true; await probe.job.catch(() => undefined) }
    }))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }).catch((error) => {
      console.error(`Could not remove isolated storage fixture ${root}:`, error.message)
    })
  }
}

module.exports = { verifyCurrentStorage }
