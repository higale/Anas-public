const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
const quotePowerShell = (text) => `'${text.replaceAll("'", "''")}'`
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

// Keep Windows process handles until verification/cleanup is complete. Birth
// times bind fixture identities before capture; open handles prevent PID reuse.
function windowsProbe(koffi) {
  const kernel = koffi.load('kernel32.dll')
  const open = kernel.func('__stdcall', 'OpenProcess', 'void*', ['uint32', 'int', 'uint32'])
  const current = kernel.func('__stdcall', 'GetCurrentProcess', 'void*', [])
  const times = kernel.func('__stdcall', 'GetProcessTimes', 'int', ['void*', 'void*', 'void*', 'void*', 'void*'])
  const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void*', 'uint32'])
  const terminate = kernel.func('__stdcall', 'TerminateProcess', 'int', ['void*', 'uint32'])
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['void*'])
  const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32', [])
  const birth = (handle) => {
    const data = Buffer.alloc(32)
    if (!times(handle, data, data.subarray(8), data.subarray(16), data.subarray(24))) throw new Error(`GetProcessTimes: ${lastError()}`)
    return data.readBigUInt64LE().toString()
  }
  const exited = (handle) => {
    const result = wait(handle, 0)
    if (result === 0) return true
    if (result === 0x102) return false
    throw new Error(`WaitForSingleObject: ${lastError()}`)
  }
  return {
    birth: () => birth(current()),
    capture: (identity) => {
      if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/.test(identity.birth)) throw new Error('Invalid fixture identity.')
      const handle = open(0x0010_0000 | 0x1000 | 0x0001, 0, identity.pid)
      if (!handle) {
        if (lastError() === 87) return undefined // Already exited before capture.
        throw new Error(`OpenProcess: ${lastError()}`)
      }
      try {
        if (birth(handle) !== identity.birth) throw new Error('Fixture PID was reused before capture.')
        return handle
      } catch (error) { close(handle); throw error }
    },
    exited,
    terminate: (handle) => {
      if (!exited(handle) && !terminate(handle, 1) && !exited(handle)) throw new Error(`TerminateProcess: ${lastError()}`)
    },
    close: (handle) => { if (!close(handle)) throw new Error(`CloseHandle: ${lastError()}`) }
  }
}

// A real PTY foreground process and its child both resist graceful termination.
// Heartbeats prove that hiding the window does not just leave stale PID records.
const fixtureSource = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const [root, role = 'parent'] = process.argv.slice(2)
const probe = process.platform === 'win32' ? (${windowsProbe.toString()})(require(${JSON.stringify(require.resolve('koffi'))})) : undefined
process.on('SIGHUP', () => {})
process.on('SIGTERM', () => {})
writeFileSync(join(root, role + '.json'), JSON.stringify({ pid: process.pid, tty: !!process.stdin.isTTY && !!process.stdout.isTTY, birth: probe?.birth() }))
if (role === 'parent') spawn(process.execPath, [__filename, root, 'child'], { stdio: 'inherit' })
let counter = 0
setInterval(() => writeFileSync(join(root, role + '.heartbeat'), String(++counter)), 100)
console.log('PTY_LIFECYCLE_READY:' + role)
`

async function readIdentity(root, role) {
  const result = JSON.parse(await readFile(join(root, `${role}.json`), 'utf8'))
  assert.ok(Number.isSafeInteger(result.pid) && result.pid > 0)
  return result
}

async function reapFixtureProcesses(workspace, probe, handles) {
  // Only fixture-owned IDs from this fresh directory may need failure cleanup.
  for (const role of ['parent', 'child']) {
    const identity = await readIdentity(workspace, role).catch(() => undefined)
    if (!identity) continue
    if (probe) {
      const handle = handles.get(role) ?? probe.capture(identity)
      if (!handle) continue
      handles.set(role, handle)
      probe.terminate(handle)
      await expect.poll(() => probe.exited(handle), { timeout: 5_000 }).toBe(true)
      continue
    }
    try { process.kill(identity.pid, 'SIGKILL') } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    await expect.poll(() => !alive(identity.pid), { timeout: 5_000 }).toBe(true)
  }
}

async function verifyPtyLifecycle(launchApplication) {
  if (!['darwin', 'win32', 'linux'].includes(process.platform)) {
    console.log('PTY window/quit lifecycle: not run on this platform.')
    return
  }
  for (const action of process.platform === 'darwin' ? ['hide-and-quit'] : ['window-close', 'app-quit']) {
    await verifyLifecycleAction(launchApplication, action)
  }
}

async function verifyLifecycleAction(launchApplication, action) {
  const root = await mkdtemp(join(tmpdir(), 'anas-electron-pty-'))
  const workspace = join(root, 'workspace')
  const identities = []
  const providerErrors = []
  let application
  let lifecycleVerified = false
  let requests = 0
  let pendingRequestClosed = false
  let shellName
  const probe = process.platform === 'win32' ? windowsProbe(require('koffi')) : undefined
  const handles = new Map()
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/chat/completions')
      request.setEncoding('utf8')
      let body = ''
      for await (const chunk of request) {
        body += chunk
        assert.ok(body.length <= 1_000_000, 'Unexpectedly large fixture model request.')
      }
      const input = JSON.parse(body)
      assert.equal(input.stream, false)
      assert.equal(input.model, 'pty-lifecycle-fixture')
      requests += 1
      if (requests === 2) {
        assert.ok(input.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'pty-lifecycle-call'))
        response.on('close', () => { pendingRequestClosed = true })
        // Keep the native model request in flight while the managed PTY runs.
        // Normal application shutdown must cancel both of these resources.
        return
      }
      assert.equal(requests, 1, 'The fixture must not start another terminal.')
      const shell = input.tools.filter((tool) => tool.function.parameters.properties.pty)
      assert.equal(shell.length, 1, 'The actual command shell must expose explicit PTY support.')
      shellName = shell[0].function.name
      const parts = [process.execPath, join(workspace, 'fixture.cjs'), workspace]
      const command = process.platform === 'win32'
        ? `& ${parts.map(quotePowerShell).join(' ')}` : parts.map(quote).join(' ')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'pty-lifecycle-response', object: 'chat.completion', created: 1,
        model: input.model, choices: [{ index: 0, finish_reason: 'tool_calls', message: {
          role: 'assistant', content: null, tool_calls: [{ id: 'pty-lifecycle-call', type: 'function',
            function: { name: shellName, arguments: JSON.stringify({ command, working_dir: workspace,
              summary: 'Run the isolated PTY lifecycle fixture', pty: { columns: 80, rows: 24 } }) } }]
        } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }))
    })().catch((error) => {
      providerErrors.push(String(error))
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error), type: 'fixture_error' } }))
    })
  })
  try {
    await mkdir(workspace)
    await writeFile(join(workspace, 'fixture.cjs'), fixtureSource)
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    application = await launchApplication(join(root, 'profile'))
    const page = await application.firstWindow({ timeout: 45_000 })
    await page.waitForSelector('[data-agent-composer-input]', { timeout: 45_000 })
    const submission = await page.evaluate(async ({ baseUrl, workspace }) => {
      const api = globalThis.gale
      const providers = await api.config.saveModelProvider({ name: 'PTY fixture', protocol: 'openai_chat_completions',
        baseUrl, apiKey: '', modelListAuth: 'bearer', parameters: {} })
      const providerId = providers.providers.find((provider) => provider.name === 'PTY fixture').id
      const models = await api.config.saveProviderModel({ providerId, displayName: 'PTY fixture', model: 'pty-lifecycle-fixture',
        parameters: {}, parameterPresetMode: 'none', capabilities: { vision: false, toolUse: true }, stream: false,
        maxContextTokens: 128000, maxOutputTokens: 4096, contextCompressionThreshold: 0.8, contextCompressionEnabled: false })
      const modelConfigId = models.providers.find((provider) => provider.id === providerId).models[0].id
      await api.config.selectDefaultModel(modelConfigId)
      const projectResult = await api.projects.create({ kind: 'workspace', name: 'PTY lifecycle', sourceFolders: [workspace],
        advancedSettings: true, codingMode: true, prompt: '', restrictSubagents: false,
        capabilities: { profile: false, environment: false, workspace: true, memory: false, applicationEnvironment: false,
          backgroundTools: true, subagents: false, planning: false, toolMode: 'selected',
          tools: ['run_shell', 'read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call'],
          mcp: { defaultMode: 'selected', servers: [] },
          skills: { enabled: false, project: false, mode: 'custom', entries: [] } } })
      if (projectResult.status === 'error') throw new Error(JSON.stringify(projectResult.error))
      const project = projectResult.value
      return api.agent.runs.submit({ requestId: globalThis.crypto.randomUUID(),
        newThread: { title: 'PTY lifecycle', projectId: project.id, modelConfigId, accessMode: 'full_access' },
        text: 'Start the isolated interactive fixture and leave it running for window/quit verification.' })
    }, { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, workspace })
    await expect(async () => {
      assert.deepEqual(providerErrors, [])
      for (const role of ['parent', 'child']) {
        const identity = await readIdentity(workspace, role)
        assert.equal(identity.tty, true, `${role} must own a real terminal.`)
        assert.equal(alive(identity.pid), true)
      }
      assert.equal(requests, 2, 'The native agent loop must receive the real shell tool result.')
    }).toPass({ timeout: 20_000 })
    for (const role of ['parent', 'child']) {
      const identity = await readIdentity(workspace, role)
      identities.push({ role, ...identity })
      if (probe) {
        const handle = probe.capture(identity)
        assert.ok(handle, 'Fixture process exited before lifecycle verification.')
        handles.set(role, handle)
      }
    }
    if (action === 'hide-and-quit') {
      const before = await Promise.all(identities.map(({ role }) => readFile(join(workspace, `${role}.heartbeat`), 'utf8')))
      await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
      assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => ({
        visible: window.isVisible(), destroyed: window.isDestroyed()
      }))), [{ visible: false, destroyed: false }])
      await expect(async () => {
        for (const [index, { role, pid }] of identities.entries()) {
          assert.equal(alive(pid), true)
          assert.ok(Number(await readFile(join(workspace, `${role}.heartbeat`), 'utf8')) > Number(before[index]))
        }
      }).toPass({ timeout: 5_000 })
      assert.equal(pendingRequestClosed, false, 'Closing the window must not cancel the active model request.')
      await application.evaluate(({ app }) => { app.emit('activate') })
      await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true)
      const snapshot = await page.evaluate((id) => globalThis.gale.agent.threads.get(id), submission.thread.id)
      assert.equal(snapshot.pendingRun?.id, submission.run.id, 'Reopening must preserve the running task.')
      assert.equal(snapshot.pendingRun?.status, 'running')
    }
    const main = application.process()
    await application.evaluate(({ app, BrowserWindow }, action) => {
      setImmediate(() => action === 'window-close' ? BrowserWindow.getAllWindows()[0].close() : app.quit())
    }, action)
    await expect.poll(() => main.exitCode !== null || main.signalCode !== null, { timeout: 15_000 }).toBe(true)
    assert.equal(main.exitCode, 0, 'Normal quit must exit cleanly.')
    assert.equal(main.signalCode, null, 'The fixture must not replace normal quit with a forced process kill.')
    await expect.poll(() => identities.every(({ role, pid }) => probe ? probe.exited(handles.get(role)) : !alive(pid)), { timeout: 5_000,
      message: 'Normal application quit must reap the PTY foreground process and its child.' }).toBe(true)
    await expect.poll(() => pendingRequestClosed).toBe(true)
    assert.deepEqual(providerErrors, [])
    lifecycleVerified = true
    console.log(`${process.platform} PTY lifecycle passed (${shellName}, ${action}): real TTY in parent/child, normal exit cancels the model request and reaps both processes.`)
  } finally {
    await application?.close().catch(() => undefined)
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    try {
      if (!lifecycleVerified) await reapFixtureProcesses(workspace, probe, handles)
    } finally {
      if (probe) for (const handle of handles.values()) probe.close(handle)
    }
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyPtyLifecycle }
