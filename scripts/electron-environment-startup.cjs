const assert = require('node:assert/strict')
const { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { _electron: electron } = require('playwright')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')

// Run the built main process with a supervised probe held until the real
// renderer is interactive. No product test mode or timed sleep is needed.
async function verifyEnvironmentStartup(repositoryRoot, executablePath) {
  const root = await mkdtemp(join(tmpdir(), 'anas-startup-e2e-'))
  let application
  try {
    const documents = join(root, 'documents')
    await mkdir(documents)
    const traceDirectory = join(root, 'profile', 'dev', 'model-http')
    await mkdir(traceDirectory, { recursive: true })
    await writeFile(join(traceDirectory, 'fixture.txt'), '1234567')
    await symlink(join(repositoryRoot, 'data'), join(root, 'data'), 'junction')
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'anas-startup-test', version: '1.0.0', main: 'main.cjs'
    }))
    const probeDirectory = join(root, 'probe')
    const probeScript = join(probeDirectory, 'python.cjs')
    const probeStarted = join(probeDirectory, 'started')
    const probeRelease = join(probeDirectory, 'release')
    await mkdir(probeDirectory)
    await writeFile(probeScript, `
      const fs = require('node:fs')
      let completed = false
      const finish = () => {
        if (completed || !fs.existsSync(${JSON.stringify(probeRelease)})) return
        completed = true
        watcher.close()
        process.stdout.write('3.13.3\\n' + process.execPath + '\\n')
      }
      const watcher = fs.watch(${JSON.stringify(probeDirectory)}, finish)
      fs.writeFileSync(${JSON.stringify(probeStarted)}, 'ready')
      finish()
    `)
    await writeFile(join(root, 'main.cjs'), `
      require('electron').app.setPath('documents', ${JSON.stringify(documents)})
      const { ipcMain } = require('electron')
      let releaseTrace
      const tracePending = new Promise((resolve) => { releaseTrace = resolve })
      globalThis.__anasDevStorageProbe = { calls: {}, release: releaseTrace }
      const originalHandle = ipcMain.handle.bind(ipcMain)
      ipcMain.handle = (channel, handler) => originalHandle(channel, async (...args) => {
        if (['app:getDeveloperHttpTraceUsage', 'app:getDataStorageUsage', 'agent:storage:getUsage'].includes(channel)) {
          const calls = globalThis.__anasDevStorageProbe.calls
          calls[channel] = (calls[channel] || 0) + 1
          if (channel === 'app:getDeveloperHttpTraceUsage') await tracePending
        }
        return handler(...args)
      })
      const cp = require('node:child_process')
      const fs = require('node:fs')
      const originalSpawn = cp.spawn
      const python = process.platform === 'win32' ? 'python.exe' : 'python3'
      cp.spawn = function (...args) {
        const child = originalSpawn.apply(this, args)
        if (typeof child.send !== 'function') return child
        const send = child.send.bind(child)
        child.send = (message, ...rest) => {
          const probeArgs = message?.args
          const pythonProbe = message?.executable === python && Array.isArray(probeArgs) && probeArgs.includes('-c')
          const versionProbe = pythonProbe || Array.isArray(probeArgs) && probeArgs.some((arg) => /^(?:--?version|version)$| --version$/.test(arg))
          if (message?.type !== 'start' || !versionProbe) return send(message, ...rest)
          if (pythonProbe) {
            globalThis.__anasEnvironmentProbe = {
              get pending() { return fs.existsSync(${JSON.stringify(probeStarted)}) && !fs.existsSync(${JSON.stringify(probeRelease)}) },
              release() { fs.writeFileSync(${JSON.stringify(probeRelease)}, 'released') }
            }
          }
          // Keep the real supervisor, dispatch handshake, process and result
          // path. Only the controlled probe command and its deadline differ.
          return send({ ...message,
            executable: process.execPath,
            args: pythonProbe ? [${JSON.stringify(probeScript)}] : ['-e', 'process.exit(1)'],
            environment: { ...message.environment, ELECTRON_RUN_AS_NODE: '1' },
            ...(pythonProbe ? { timeoutMs: 0 } : {})
          }, ...rest)
        }
        return child
      }
      require(${JSON.stringify(join(repositoryRoot, 'out/main/index.js'))})
    `)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    application = await electron.launch({
      executablePath,
      args: [root, '--data-dir', join(root, 'profile'),
        ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [])],
      cwd: repositoryRoot,
      env,
      timeout: 45_000
    })
    const page = await application.firstWindow({ timeout: 10_000 })
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible({ timeout: 10_000 })
    const profile = join(root, 'profile')
    assert.ok((await readdir(join(profile, 'skills_examples'))).length > 0)
    assert.deepEqual(await readdir(join(profile, 'tools')), [])
    const rawTool = JSON.parse(await readFile(join(profile, 'tools_examples/read_text_raw/TOOL.json'), 'utf8'))
    assert.equal(rawTool.name, 'read_text_raw')
    await expect.poll(() => application.evaluate(() => globalThis.__anasEnvironmentProbe?.pending)).toBe(true)
    const initial = await page.evaluate(async () => (await globalThis.gale.config.get()).settings.environmentContext)
    assert.equal(initial.customInformationEnabled, true)
    assert.equal(initial.customInformation, '')
    await page.locator('.sidebar-settings').click()
    await page.getByRole('menuitem', { name: /^(设置|Settings)$/ }).click()
    await page.locator('[data-settings-tab="environment"]').click()
    const input = page.locator('#custom-environment-information-input')
    await expect(input).toBeVisible()
    await expect(input).toHaveValue('')
    assert.equal(await application.evaluate(() => globalThis.__anasEnvironmentProbe.pending), true)
    await application.evaluate(() => globalThis.__anasEnvironmentProbe.release())
    const command = process.platform === 'win32' ? 'python' : 'python3'
    const expected = `Available common commands:\n- ${command}: 3.13.3`
    await expect(input).toHaveValue(expected)
    assert.equal(await page.evaluate(async () => (await globalThis.gale.config.get()).settings.environmentContext.customInformation), expected)
    const storageCallsBeforeDev = await application.evaluate(() => ({ ...globalThis.__anasDevStorageProbe.calls }))
    await page.locator('[data-settings-tab="dev"]').click()
    await expect.poll(() => application.evaluate(() => globalThis.__anasDevStorageProbe.calls['app:getDeveloperHttpTraceUsage'] || 0)).toBe(1)
    const traceToggle = page.getByRole('checkbox')
    await expect(traceToggle).toBeVisible()
    await traceToggle.click()
    await expect(traceToggle).toBeChecked()
    assert.equal(await page.evaluate(() => globalThis.gale.app.getDeveloperHttpTraceEnabled()), true)
    await traceToggle.click()
    await expect(traceToggle).not.toBeChecked()
    assert.deepEqual(await application.evaluate(() => globalThis.__anasDevStorageProbe.calls), {
      ...storageCallsBeforeDev,
      'app:getDeveloperHttpTraceUsage': 1
    }, 'Dev must measure only its HTTP traces, without requesting general storage scans.')
    await page.locator('[data-settings-tab="general"]').click()
    await expect.poll(() => application.evaluate(() => globalThis.__anasDevStorageProbe.calls['app:getDataStorageUsage'] || 0))
      .toBeGreaterThan(storageCallsBeforeDev['app:getDataStorageUsage'] || 0)
    await expect.poll(() => application.evaluate(() => globalThis.__anasDevStorageProbe.calls['agent:storage:getUsage'] || 0))
      .toBeGreaterThan(storageCallsBeforeDev['agent:storage:getUsage'] || 0)
    const storageCallsAfterGeneral = await application.evaluate(() => ({ ...globalThis.__anasDevStorageProbe.calls }))
    await page.locator('[data-settings-tab="dev"]').click()
    await expect(traceToggle).toBeVisible()
    await traceToggle.click()
    await expect(traceToggle).toBeChecked()
    assert.deepEqual(await application.evaluate(() => globalThis.__anasDevStorageProbe.calls), storageCallsAfterGeneral,
      'Reopening Dev must reuse the pending trace measurement and leave general storage alone.')
    await application.evaluate(() => globalThis.__anasDevStorageProbe.release())
    await expect(page.getByText('7 B', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(tmpdir(), 'anas-dev-settings.png') })
    console.log('Dev settings E2E passed: controls and tab switching stay interactive during trace measurement; only General requests full data and database storage scans.')
    console.log('Startup E2E passed: skill/tool examples exist before import; window and settings are interactive before detection completes; the saved result arrives without reloading.')
  } finally {
    await closeElectronTestApplication(application, () => application.evaluate(() => {
      globalThis.__anasEnvironmentProbe?.release()
      globalThis.__anasDevStorageProbe?.release()
    }))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

module.exports = { verifyEnvironmentStartup }
