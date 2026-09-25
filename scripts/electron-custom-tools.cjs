const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

async function verifyCustomTools(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-custom-pty-e2e-'))
  const workspace = join(root, 'workspace')
  const profile = join(root, 'profile')
  const errors = []
  let application
  let round = 0
  let callId
  let terminalId
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      assert.equal(input.stream, false)
      assert.equal(input.tools.filter(tool => tool.function.name === 'ask_custom').length, 1)
      assert.ok(input.tools.some(tool => tool.function.name === 'write_call'))
      assert.ok(!input.tools.some(tool => tool.function.parameters.properties?.pty), 'No Shell tool should be enabled.')
      const last = input.messages.filter(message => message.role === 'tool').at(-1)
      const text = last && (typeof last.content === 'string' ? last.content : last.content.map(block => block.text ?? '').join(''))
      let name
      let args
      switch (round++) {
        case 0: name = 'ask_custom'; args = { title: '中文 "quote"' }; break
        case 1:
          callId = JSON.parse(text).call_id
          assert.ok(callId, 'The waiting custom tool must return a background handle.')
          name = 'read_call'; args = { call_id: callId }; break
        case 2:
          terminalId = JSON.parse(text).pty.terminal_id
          assert.ok(terminalId)
          name = 'read_call_output'; args = { call_id: callId, output_offset: 0, output_length: 2000 }; break
        case 3:
          assert.match(text, /TTY:true:true/)
          assert.match(text, /CUSTOM_PROMPT/)
          assert.match(text, /DIAGNOSTIC/)
          assert.match(text, /PACKAGE_SOURCE:project/)
          name = 'write_call'; args = { call_id: callId, terminal_id: terminalId, action: { type: 'text', text: '中文确认\r' } }; break
        case 4:
          assert.equal(JSON.parse(text).ok, true)
          name = 'wait_call'; args = { call_id: callId, timeout: 10 }; break
        case 5:
          assert.match(text, /completed/)
          name = 'read_call_output'; args = { call_id: callId, output_offset: 0, output_length: 2000 }; break
        case 6:
          assert.match(text, /ANSWER:中文确认/)
          break
        default: throw new Error('Unexpected extra model request.')
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: `custom-response-${round}`, object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, finish_reason: name ? 'tool_calls' : 'stop', message: name
          ? { role: 'assistant', content: null, tool_calls: [{ id: `custom-call-${round}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
          : { role: 'assistant', content: 'Custom terminal verified.' } }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }))
    })().catch(error => {
      errors.push(String(error))
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: String(error) } }))
    })
  })
  try {
    await mkdir(workspace)
    const questionScript = `const fs=require('node:fs');fs.writeFileSync('arguments.json',process.argv[2]);const rl=require('node:readline').createInterface({input:process.stdin,output:process.stdout});console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY);console.error('DIAGNOSTIC');rl.question('CUSTOM_PROMPT:',answer=>{console.log('ANSWER:'+answer);rl.close()})`
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    application = await launchApplication(profile)
    const page = await application.firstWindow()
    await page.waitForSelector('[data-agent-composer-input]')
    await page.evaluate(() => globalThis.gale.config.updateSettings({ language: 'en' }))
    await page.reload()
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="tools"]').click()
    const customToolsGroup = page.getByRole('button', { name: /^Custom tools\s*\d+$/ })
    await expect(customToolsGroup).toHaveText('Custom tools0')
    await customToolsGroup.click()
    await page.getByRole('button', { name: 'Add custom tool', exact: true }).click()
    const editor = page.getByRole('dialog')
    const interactive = editor.getByRole('checkbox', { name: 'Interactive terminal (PTY)', exact: true })
    await expect(interactive).not.toBeChecked()
    const timeout = editor.getByRole('spinbutton', { name: 'Timeout (seconds)', exact: true })
    await expect(timeout).toHaveValue('')
    await expect(timeout).toHaveAttribute('placeholder', 'No limit')
    await timeout.fill('120')
    await timeout.fill('0')
    await expect(timeout).toHaveValue('')
    await editor.getByLabel('Tool name', { exact: true }).fill('ask_custom')
    await editor.getByLabel('Description', { exact: true }).fill('Ask a question through a terminal.')
    await editor.getByRole('textbox', { name: 'Command', exact: true }).fill(`"${process.execPath}" question.cjs {{args}}`)
    await interactive.check()
    // Settle scrolling before the tooltip's delayed pointer-entry handler.
    await timeout.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await timeout.hover()
    await expect(page.getByRole('tooltip')).toContainText('Leave blank for no limit')
    await interactive.scrollIntoViewIfNeeded()
    await page.mouse.move(0, 0)
    await interactive.hover()
    await expect(page.getByRole('tooltip')).toContainText('Requires Background tools.')
    if (process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT + '.tooltip.png' })
    await editor.getByRole('button', { name: 'Save', exact: true }).hover()
    await expect(page.getByRole('tooltip')).toHaveCount(0)
    if (process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT })
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).not.toBeVisible()
    await expect(customToolsGroup).toHaveText('Custom tools1')
    await page.getByRole('button', { name: 'ask_custom', exact: true }).dblclick()
    await expect(interactive).toBeChecked()
    await expect(timeout).toHaveValue('')
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
    const stored = JSON.parse(await readFile(join(profile, 'tools/ask_custom/TOOL.json'), 'utf8'))
    assert.equal(stored.interactive, true)
    assert.equal(stored.timeout_seconds, 0)
    await writeFile(join(profile, 'tools/ask_custom/question.cjs'), questionScript)
    assert.equal(JSON.parse(await readFile(join(profile, 'config/tools.json'), 'utf8')).tools, undefined)
    const projectToolDir = join(workspace, '.agents/tools/question')
    await mkdir(projectToolDir, { recursive: true })
    await writeFile(join(projectToolDir, 'TOOL.json'), JSON.stringify({ ...stored, id: 'project-question' }))
    await writeFile(join(projectToolDir, 'question.cjs'), `console.log('PACKAGE_SOURCE:project');` + questionScript)
    const catalogs = await page.evaluate(async workspace => ({ global: await globalThis.gale.tools.get(), project: await globalThis.gale.tools.get(undefined, [workspace]) }), workspace)
    assert.equal(catalogs.global.tools.length, 1)
    assert.equal(catalogs.project.tools.length, 2)
    assert.equal(catalogs.project.tools[0].source, 'project')
    if (process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT + '.catalog.png' })
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    await page.locator('[data-settings-tab="capabilities"]').click()
    await page.locator('summary').filter({ hasText: 'Custom tools' }).click()
    const selectedTool = page.getByRole('checkbox', { name: 'User ask_custom', exact: true })
    const customGroup = page.getByRole('checkbox', { name: 'Custom tools', exact: true })
    await expect(selectedTool).not.toBeChecked()
    await customGroup.check()
    await expect(selectedTool).toBeChecked()
    await expect(async () => {
      const config = await page.evaluate(() => globalThis.gale.config.get())
      assert.deepEqual(config.defaultCapabilities.capabilities.customTools.entries, [catalogs.global.tools[0].id])
    }).toPass()
    if (process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT + '.capabilities.png' })
    await page.locator('[data-settings-tab="tools"]').click()
    await customToolsGroup.click()
    await page.getByRole('button', { name: 'ask_custom', exact: true }).dblclick()
    await editor.getByLabel('Tool name', { exact: true }).fill('renamed_custom')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).not.toBeVisible()
    await expect(page.getByRole('button', { name: 'renamed_custom', exact: true })).toBeVisible()
    const renamed = JSON.parse(await readFile(join(profile, 'tools/renamed_custom/TOOL.json'), 'utf8'))
    assert.equal(renamed.id, stored.id)
    assert.equal(renamed.name, 'renamed_custom')
    await assert.rejects(readFile(join(profile, 'tools/ask_custom/TOOL.json')), { code: 'ENOENT' })
    const afterRename = await page.evaluate(() => globalThis.gale.config.get())
    assert.deepEqual(afterRename.defaultCapabilities.capabilities.customTools.entries, [catalogs.global.tools[0].id])
    if (process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT + '.renamed.png' })
    await page.getByRole('button', { name: 'renamed_custom', exact: true }).dblclick()
    await editor.getByLabel('Tool name', { exact: true }).fill('ask_custom')
    await editor.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(editor).not.toBeVisible()
    const submission = await page.evaluate(async ({ workspace, baseUrl, toolIds }) => {
      const api = globalThis.gale
      const providers = await api.config.saveModelProvider({ name: 'Custom fixture', protocol: 'openai_chat_completions',
        baseUrl, apiKey: '', modelListAuth: 'bearer', parameters: {} })
      const providerId = providers.providers.find(provider => provider.name === 'Custom fixture').id
      const models = await api.config.saveProviderModel({ providerId, displayName: 'Custom fixture', model: 'custom-fixture',
        parameters: {}, parameterPresetMode: 'none', capabilities: { vision: false, toolUse: true }, stream: false,
        maxContextTokens: 128000, maxOutputTokens: 4096, contextCompressionThreshold: 0.8, contextCompressionEnabled: false })
      const modelConfigId = models.providers.find(provider => provider.id === providerId).models[0].id
      const base = (await api.projects.list()).find(project => project.kind === 'workspace')
      const project = await api.projects.create({ ...base, name: 'Custom terminal fixture', sourceFolders: [workspace],
        advancedSettings: true, codingMode: false, prompt: '', restrictSubagents: false,
        capabilities: { ...base.capabilities, profile: false, environment: false, workspace: false, memory: false,
          applicationEnvironment: false, backgroundTools: true, subagents: false, planning: false,
          toolMode: 'selected', tools: [], customTools: { project: false, entries: toolIds },
          mcp: { defaultMode: 'selected', servers: [] }, skills: { enabled: false, mode: 'custom', project: false, entries: [] } } })
      if (project.status !== 'ok') throw new Error(JSON.stringify(project.error))
      return api.agent.runs.submit({ requestId: globalThis.crypto.randomUUID(),
        newThread: { title: 'Custom terminal fixture', projectId: project.value.id, modelConfigId, accessMode: 'full_access' },
        text: 'Run the interactive custom tool, read the prompt, send input, and verify completion.' })
    }, { workspace, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, toolIds: catalogs.project.tools.map(tool => tool.id) })
    await expect(async () => {
      assert.deepEqual(errors, [])
      assert.equal(round, 7)
      const snapshot = await page.evaluate(id => globalThis.gale.agent.threads.get(id), submission.thread.id)
      assert.equal(snapshot.pendingRun, undefined)
      assert.ok(snapshot.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text.includes('Custom terminal verified.'))))
    }).toPass({ timeout: 45_000 })
    assert.deepEqual(JSON.parse(await readFile(join(projectToolDir, 'arguments.json'), 'utf8')), { title: '中文 "quote"' })
    await assert.rejects(readFile(join(workspace, 'arguments.json')), { code: 'ENOENT' })
    const exampleRoot = join(await realpath(profile), 'tools_examples')
    await application.evaluate(({ dialog }, paths) => {
      globalThis.__toolImportDialogs = []
      dialog.showOpenDialog = async (...args) => {
        globalThis.__toolImportDialogs.push(args.at(-1))
        return { canceled: false, filePaths: paths }
      }
    }, ['read_text_raw', 'json_format'].map(name => join(exampleRoot, name)))
    await page.getByRole('button', { name: 'Import tools', exact: true }).click()
    await expect(page.getByRole('button', { name: 'read_text_raw', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'json_format', exact: true })).toBeVisible()
    assert.deepEqual(await application.evaluate(() => globalThis.__toolImportDialogs), [{ defaultPath: exampleRoot, properties: ['openDirectory', 'multiSelections'] }])
    const importedConfig = await page.evaluate(() => globalThis.gale.config.get())
    assert.equal(importedConfig.customTools.length, 3)
    await expect(customToolsGroup).toHaveText('Custom tools3')
    assert.deepEqual(importedConfig.defaultCapabilities.capabilities.customTools.entries, [catalogs.global.tools[0].id])
    const importedManifest = await readFile(join(profile, 'tools/read_text_raw/TOOL.json'), 'utf8')
    assert.equal(importedManifest, await readFile(join(exampleRoot, 'read_text_raw/TOOL.json'), 'utf8'))
    assert.equal(await readFile(join(profile, 'tools/read_text_raw/scripts/run.py'), 'utf8'), await readFile(join(exampleRoot, 'read_text_raw/scripts/run.py'), 'utf8'))
    if (process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CUSTOM_TOOL_SCREENSHOT + '.imports.png' })
    await page.getByRole('button', { name: 'Import tools', exact: true }).click()
    await expect(page.getByText('Tool or directory read_text_raw already exists. Nothing was imported.', { exact: true })).toBeVisible()
    assert.equal(await readFile(join(profile, 'tools/read_text_raw/TOOL.json'), 'utf8'), importedManifest)
    console.log('Custom tools Electron E2E passed: package directory execution, rename and selection, PTY interaction, example import dialog/default path, copied resources, default-off selections and duplicate rejection.')
  } finally {
    await application?.close()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyCustomTools }
