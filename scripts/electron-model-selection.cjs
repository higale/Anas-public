const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const settingsDefaults = require('../data/config/settings.json')
const { restrict_subagents, ...capabilityDefaults } = require('../data/config/capabilities.json')

async function verifyModelSelection(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-model-selection-e2e-'))
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('anas-model-selection-e2e-')) {
    throw new Error('Unexpected model-selection test directory.')
  }
  const profile = join(root, 'profile')
  const workspace = join(root, 'workspace')
  const requests = []
  const errors = []
  let application
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(input.stream, false)
      assert.ok(input.tools.some(tool => tool.function.name === 'write_todos'))
      requests.push({ input, response })
    })().catch(error => {
      errors.push(String(error))
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error) } }))
    })
  })
  const finishRequest = (index, toolCall) => {
    const { input, response } = requests[index]
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ id: `model-selection-${index}`, object: 'chat.completion', created: 1,
      model: input.model, choices: [{ index: 0, finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null, tool_calls: [toolCall ?? { id: `planning-${index}`, type: 'function',
          function: { name: 'write_todos', arguments: JSON.stringify({ todos: [
            { content: 'Verify live model selection', status: index === 0 ? 'in_progress' : 'completed' }
          ] }) } }]
      } }], usage: { prompt_tokens: index === 0 ? 19000 : 1500, completion_tokens: 30,
        total_tokens: index === 0 ? 19030 : 1530 } }))
  }

  try {
    await mkdir(join(profile, 'config'), { recursive: true })
    await mkdir(workspace)
    await writeFile(join(root, 'approval.txt'), 'Controlled approval target outside the workspace.\n')
    const settings = structuredClone(settingsDefaults)
    settings.language = 'en'
    settings.environment_context.custom_information = 'Controlled local model selection test.'
    await writeFile(join(profile, 'config', 'settings.json'), `${JSON.stringify(settings)}\n`)
    const capabilities = { ...structuredClone(capabilityDefaults), application_environment: false,
      background_tools: false, subagents: false, planning: true, tool_mode: 'selected', tools: ['read_file'],
      profile: true, environment: false, workspace: false, memory: false,
      skills: { enabled: false, mode: 'custom', project: false, entries: [] },
      mcp: { default_mode: 'selected', servers: [] } }
    const timestamp = new Date().toISOString()
    await writeFile(join(profile, 'projects.json'), `${JSON.stringify({ version: 4, projects: [{
      id: 'default-workspace', kind: 'workspace', name: 'Model selection test', pinned: false, collapsed: false,
      sourceFolders: [workspace], capabilities, restrict_subagents, advanced_settings: true,
      coding_mode: false, prompt: '', createdAt: timestamp, updatedAt: timestamp
    }] })}\n`)
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    application = await launchApplication(profile)
    const page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible()
    const selection = await page.evaluate(async (port) => {
      const api = globalThis.gale.config
      const saved = await api.saveModelProvider({ name: 'Controlled model server', protocol: 'openai_chat_completions',
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {}, modelListUrl: '', modelListAuth: 'bearer' })
      const providerId = saved.providers.find(provider => provider.name === 'Controlled model server').id
      let config
      for (const [index, name] of ['A', 'B'].entries()) {
        config = await api.saveProviderModel({ providerId, displayName: `Model ${name}`, model: `model-${name.toLowerCase()}`,
          parameters: { temperature: 0.2 }, parameterPresetMode: 'custom',
          parameterPresets: [{ id: 'balanced', name: 'Balanced', parameters: { temperature: 0.4 } },
            { id: 'deep', name: 'Deep', parameters: { temperature: 0.7 } }],
          capabilities: { vision: true, toolUse: true }, stream: false,
          maxContextTokens: index === 0 ? 50000 : 100000, maxOutputTokens: index === 0 ? 10000 : 5000,
          contextCompressionThreshold: index === 0 ? 0.8 : 0.6, contextCompressionEnabled: true })
      }
      const models = config.providers.find(provider => provider.id === providerId).models
      return { providerId, firstId: models[0].id, secondId: models[1].id }
    }, server.address().port)
    const modelPicker = page.getByRole('button', { name: 'Select model', exact: true })
    const presetPicker = page.getByRole('button', { name: 'Reasoning options', exact: true })
    await modelPicker.click()
    await page.getByRole('menuitemradio', { name: /^Model A(?: |$)/ }).click()
    await expect(modelPicker).toHaveText('Model A')
    await page.locator('[data-agent-composer-input]').fill('Verify the model selected for the next request.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(1)
    assert.equal(requests[0].input.model, 'model-a')
    assert.equal(requests[0].input.max_tokens ?? requests[0].input.max_completion_tokens, 10000)
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled()
    await expect(modelPicker).toBeEnabled()
    await expect(presetPicker).toBeEnabled()
    const preparedStatus = await page.evaluate(async () => {
      const [thread] = await globalThis.gale.agent.threads.list()
      return (await globalThis.gale.agent.threads.get(thread.id)).contextStatus
    })
    assert.ok(preparedStatus.breakdown.toolDefinitionTokens > 0,
      'The local estimate must include the planning tool sent in the actual request.')
    assert.ok(preparedStatus.estimatedInputTokens > preparedStatus.breakdown.messageTokens,
      'Switching models must retain a full local estimate, including request tools and instructions.')
    const meter = page.locator('.context-meter')
    const row = (label) => page.locator('.context-meter-row').filter({ has: page.getByText(label, { exact: true }) })
    await meter.click()
    await expect(row('Model context window')).toContainText('50k')
    await page.keyboard.press('Escape')
    await modelPicker.click()
    await page.getByRole('menuitemradio', { name: /^Model B(?: |$)/ }).click()
    await expect(modelPicker).toHaveText('Model B')
    await presetPicker.click()
    await page.getByRole('menuitemradio', { name: 'Deep', exact: true }).click()
    await expect(presetPicker).toHaveText('Deep')
    await meter.click()
    await expect(row('Model context window')).toContainText('100k')
    await expect(row('Response reserve')).toContainText('5k')
    await expect(row('Automatic compression')).toContainText('57k · 60%')

    // The public settings API broadcasts to the running renderer; do not reload
    // or inject renderer state to make this update visible.
    await page.evaluate(async ({ providerId, secondId }) => {
      const api = globalThis.gale.config
      const config = await api.get()
      const model = config.providers.find(provider => provider.id === providerId).models.find(model => model.id === secondId)
      await api.saveProviderModel({ ...model, providerId, model: 'model-b-updated',
        maxContextTokens: 80000, maxOutputTokens: 4000, contextCompressionThreshold: 0.5,
        parameterPresets: model.parameterPresets.map(preset => preset.id === 'deep'
          ? { ...preset, parameters: { temperature: 0.8 } } : preset) })
    }, selection)
    await expect(row('Model context window')).toContainText('80k')
    await expect(row('Response reserve')).toContainText('4k')
    await expect(row('Usable context')).toContainText('76k')
    await expect(row('Automatic compression')).toContainText('38k · 50%')
    assert.equal(requests.length, 1, 'Changing settings must leave the first request pending.')
    const screenshot = process.env.ANAS_E2E_LIVE_MODEL_SCREENSHOT ?? join(tmpdir(), 'anas-live-model-selection.png')
    await page.screenshot({ path: screenshot })
    finishRequest(0)
    await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(2)
    assert.equal(requests[1].input.model, 'model-b-updated')
    assert.equal(requests[1].input.max_tokens ?? requests[1].input.max_completion_tokens, 4000)
    assert.equal(requests[1].input.temperature, 0.8)
    assert.ok(requests[1].input.messages.some(message => message.role === 'tool'))
    await expect(row('Model context window')).toContainText('80k')
    await expect(row('Automatic compression')).toContainText('38k · 50%')

    // Deleting a selection during the second request must fail before a third
    // provider request, preserving the conversation and its explicit selection.
    await page.evaluate(({ providerId, secondId }) => globalThis.gale.config.deleteProviderModel(providerId, secondId), selection)
    await expect(modelPicker).toHaveText('Model unavailable')
    await expect(meter).toHaveCount(0)
    finishRequest(1)
    await expect.poll(async () => (await page.evaluate(() => globalThis.gale.agent.threads.list()))[0]?.status,
      { timeout: 20_000 }).toBe('failed')
    const snapshot = await page.evaluate(async () => {
      const [thread] = await globalThis.gale.agent.threads.list()
      return globalThis.gale.agent.threads.get(thread.id)
    })
    assert.equal(snapshot.thread.modelConfigId, selection.secondId)
    assert.ok(snapshot.messages.some(message => message.role === 'user'))
    await expect(page.getByText(/The selected model or its provider no longer exists/).first()).toBeVisible()
    assert.equal(requests.length, 2, 'Deleted model must not fall back to another provider request.')

    // Ended runs preview the next request's current project configuration.
    // Save through the project dialog so the renderer receives the real update.
    await modelPicker.click()
    await page.getByRole('menuitemradio', { name: /^Model A(?: |$)/ }).click()
    await expect(modelPicker).toHaveText('Model A')
    await meter.click()
    const localEstimate = page.locator('.context-meter-disclosure')
      .filter({ has: page.getByText('Local estimate', { exact: true }) })
      .locator('.context-meter-disclosure-value')
    await expect(localEstimate).toBeVisible()
    const priorEstimateText = await localEstimate.innerText()
    const priorPreview = await page.evaluate((threadId) => globalThis.gale.agent.context.status(threadId), snapshot.thread.id)
    await page.keyboard.press('Escape')
    await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    const projectDialog = page.locator('.project-dialog')
    await projectDialog.getByRole('textbox', { name: 'Prompt', exact: true })
      .fill('Keep this project instruction in the next request.\n'.repeat(600))
    await projectDialog.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(projectDialog).toHaveCount(0)
    await meter.click()
    await expect(localEstimate).toBeVisible()
    await expect(localEstimate).not.toHaveText(priorEstimateText)
    const nextPreview = await page.evaluate((threadId) => globalThis.gale.agent.context.status(threadId), snapshot.thread.id)
    assert.ok(nextPreview.estimatedInputTokens > priorPreview.estimatedInputTokens + 6000,
      'The idle preview must include the newly saved project prompt.')
    assert.equal(requests.length, 2, 'Refreshing an idle context preview must not invoke the provider.')

    // A framework approval disposes the old instance but keeps the same run ID.
    // Changing the profile while waiting must preview the resumed prompt now.
    await page.keyboard.press('Escape')
    await page.evaluate((threadId) => globalThis.gale.agent.threads.setAccessMode(threadId, 'strict_approval'), snapshot.thread.id)
    await page.locator('[data-agent-composer-input]').fill('Pause for the controlled file approval, then continue.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(3)
    finishRequest(2, { id: 'approval-read', type: 'function', function: { name: 'read_file',
      arguments: JSON.stringify({ path: join(root, 'approval.txt') }) } })
    const approval = page.locator('.agent-approval')
    await expect(approval).toBeVisible()
    const interrupted = await page.evaluate((threadId) => globalThis.gale.agent.threads.get(threadId), snapshot.thread.id)
    assert.equal(interrupted.pendingRun.status, 'interrupted')
    await expect(meter).toHaveAttribute('aria-busy', 'false')
    const interruptedLabel = await meter.getAttribute('aria-label')
    const interruptedPreview = await page.evaluate((threadId) => globalThis.gale.agent.context.status(threadId), snapshot.thread.id)
    const resumedInstructions = 'Include the new assistant instructions after approval.\n'.repeat(600)
    await page.evaluate((instructions) => globalThis.gale.config.updateProfile({ assistant: { instructions } }), resumedInstructions)
    await expect(meter).toHaveAttribute('aria-busy', 'false')
    await expect(meter).not.toHaveAttribute('aria-label', interruptedLabel)
    const resumePreview = await page.evaluate((threadId) => globalThis.gale.agent.context.status(threadId), snapshot.thread.id)
    assert.equal(resumePreview.runId, interrupted.pendingRun.id)
    assert.ok(resumePreview.estimatedInputTokens > interruptedPreview.estimatedInputTokens + 6000,
      'The interrupted preview must include the current assistant profile.')
    assert.equal(requests.length, 3, 'An interrupted preview must not invoke the provider.')
    await approval.getByRole('button', { name: 'Reject (Esc)', exact: true }).click()
    await expect(approval).toHaveCount(0)
    await expect.poll(() => requests.length, { timeout: 20_000 }).toBe(4)
    assert.ok(requests[3].input.messages.some(message => message.role === 'system'
      && message.content.includes(resumedInstructions.trim())), 'The resumed request must use the changed profile.')
    const resumed = await page.evaluate((threadId) => globalThis.gale.agent.threads.get(threadId), snapshot.thread.id)
    assert.equal(resumed.pendingRun.id, interrupted.pendingRun.id)
    assert.ok(resumed.contextStatus.estimatedInputTokens > interruptedPreview.estimatedInputTokens + 6000,
      'The live report after resume must not revert to the old instance estimate.')
    const final = requests[3]
    final.response.writeHead(200, { 'content-type': 'application/json' })
    final.response.end(JSON.stringify({ id: 'model-selection-final', object: 'chat.completion', created: 1,
      model: final.input.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Verified.' } }],
      usage: { prompt_tokens: 16000, completion_tokens: 1, total_tokens: 16001 } }))
    await expect.poll(async () => (await page.evaluate(() => globalThis.gale.agent.threads.list()))[0]?.status,
      { timeout: 20_000 }).toBe('idle')
    assert.deepEqual(errors, [])
    assert.deepEqual(pageErrors, [])
    console.log(`Live model selection Electron E2E passed: pending-request model/preset selection, immediate budget broadcasts, next-request model/parameters, deleted-model termination, idle project-context refresh, interrupted profile refresh and same-run resume. Screenshot: ${screenshot}`)
  } finally {
    for (const { response } of requests) if (!response.writableEnded) response.destroy()
    server.closeAllConnections()
    await closeElectronTestApplication(application)
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

module.exports = { verifyModelSelection }
