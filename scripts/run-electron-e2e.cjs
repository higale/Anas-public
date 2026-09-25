const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { source: axeSource } = require('axe-core')
const { _electron: electron } = require('playwright')
const { expect } = require('playwright/test')
const { verifyReadonlyDiff } = require('./electron-diff-view.cjs')
const { verifyPtyLifecycle } = require('./electron-pty-lifecycle.cjs')
const { verifyEnvironmentStartup } = require('./electron-environment-startup.cjs')
const { verifyGitPanelStates } = require('./electron-git-panel.cjs')
const { verifyRoundChanges, verifyRoundChangesInApplication } = require('./electron-round-changes.cjs')
const { verifyToolArguments } = require('./electron-tool-arguments.cjs')
const { verifyCurrentStorage } = require('./electron-current-storage.cjs')
const { verifyProjectPreviews } = require('./electron-project-previews.cjs')
const { verifyProjectModelPicker } = require('./electron-project-model-picker.cjs')
const { verifyHelpDocuments } = require('./electron-help-documents.cjs')
const { verifyDefaultCapabilities } = require('./electron-default-capabilities.cjs')
const { verifyGlobalSettings } = require('./electron-global-settings.cjs')
const { verifySkillApproval } = require('./electron-skill-approval.cjs')
const { verifyCustomTools } = require('./electron-custom-tools.cjs')
const { verifyModelSelection } = require('./electron-model-selection.cjs')
const { verifyAttachmentPreviews } = require('./electron-attachment-previews.cjs')
const { restrict_subagents: defaultRestrictSubagents, ...defaultCapabilities } = require('../data/config/capabilities.json')

const repositoryRoot = resolve(__dirname, '..')
const packagedExecutable = process.env.ANAS_E2E_EXECUTABLE
  ? resolve(process.env.ANAS_E2E_EXECUTABLE)
  : undefined
const electronExecutable = packagedExecutable ?? require('electron')
let persistedSidebarWidth

async function launchApplication(testHome) {
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  if (packagedExecutable) {
    environment.ELECTRON_RENDERER_URL = 'https://renderer-environment-must-be-ignored.invalid/'
  }

  return electron.launch({
    args: [
      ...(packagedExecutable ? [] : [repositoryRoot]),
      '--data-dir',
      testHome,
      ...(typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [])
    ],
    cwd: repositoryRoot,
    env: environment,
    executablePath: electronExecutable,
    timeout: 45_000
  })
}

async function verifySpeechInput(electronApplication, page) {
  const microphone = page.locator('button').filter({ has: page.locator('svg.lucide-mic') })
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    assert.equal(await microphone.isDisabled(), true, 'Voice input must stay disabled on unsupported platforms.')
    return
  }
  // Exercise the renderer/preload/IPC path without opening the user's system
  // panel or sending global keyboard input during automated tests.
  await electronApplication.evaluate(({ ipcMain }) => {
    globalThis.__anasSpeechTestCalls = 0
    ipcMain.removeHandler('speech:openInput')
    ipcMain.handle('speech:openInput', () => {
      globalThis.__anasSpeechTestCalls += 1
      return 'requested'
    })
  })
  const input = page.locator('[data-agent-composer-input]')
  await input.fill('保留这段文字')
  await input.evaluate((element) => {
    element.setSelectionRange(1, 3)
    element.blur()
  })
  await microphone.click()
  const inputState = await input.evaluate((element) => ({
    focused: element === element.ownerDocument.activeElement,
    value: element.value,
    start: element.selectionStart,
    end: element.selectionEnd
  }))
  assert.deepEqual(inputState, { focused: true, value: '保留这段文字', start: 1, end: 3 })
  await expect.poll(() => electronApplication.evaluate(() => globalThis.__anasSpeechTestCalls), {
    message: 'The microphone must deliver exactly one speech:openInput IPC request within 5 seconds.',
    timeout: 5_000
  }).toBe(1)
  assert.equal(await microphone.getAttribute('aria-pressed'), null, 'The app must not claim to track system dictation state.')
  assert.equal(await microphone.getAttribute('aria-busy'), null)
  await input.fill('')
}

async function verifyApplication(electronApplication, verifyRestart = false) {
  const pageErrors = []
  const page = await electronApplication.firstWindow({ timeout: 45_000 })
  page.on('pageerror', (error) => pageErrors.push(error))
  await page.waitForSelector('[data-agent-composer-input]', { state: 'visible', timeout: 45_000 })

  assert.match(await page.title(), /Anas/i)
  const startupAlerts = await page.locator('[role="alert"]').allTextContents()
  const projectLoadError = startupAlerts.length === 0
    ? undefined
    : await page.evaluate(async () => {
        try {
          await globalThis.gale.projects.list()
          return undefined
        } catch (error) {
          return String(error)
        }
      })
  assert.deepEqual(startupAlerts, [], `Application displayed a startup error: ${startupAlerts.join(' | ')}${projectLoadError ? ` (${projectLoadError})` : ''}`)
  const webPreferences = await electronApplication.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences()
  ))
  assert.equal(webPreferences?.sandbox, true, 'Renderer sandbox must be enabled.')
  assert.equal(webPreferences?.contextIsolation, true, 'Renderer context isolation must be enabled.')
  assert.equal(webPreferences?.nodeIntegration, false, 'Renderer Node.js integration must be disabled.')
  if (verifyRestart) {
    const sidebarWidth = Math.round((await page.locator('.app-sidebar').boundingBox()).width)
    assert.equal(sidebarWidth, persistedSidebarWidth, 'Sidebar width was not restored after restart.')
    assert.equal(pageErrors.length, 0, `Renderer errors after restart: ${pageErrors.map(String).join('\n')}`)
    return
  }

  await verifySpeechInput(electronApplication, page)

  const appMenuTrigger = page.locator('.sidebar-settings')
  await appMenuTrigger.focus()
  await page.keyboard.press('Enter')
  const appMenu = page.locator('.app-menu-popover')
  await appMenu.waitFor({ state: 'visible' })
  assert.equal(await page.locator('.app-menu-item').first().evaluate((element) => element === element.ownerDocument.activeElement), true)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  const activeAfterMenuClose = await page.evaluate(() => ({
    className: globalThis.document.activeElement?.className,
    tagName: globalThis.document.activeElement?.tagName
  }))
  assert.equal(activeAfterMenuClose.tagName, 'BODY', `App menu restored unexpected focus: ${JSON.stringify(activeAfterMenuClose)}`)

  await appMenuTrigger.click()
  await page.locator('.app-menu-item').first().click()
  await page.locator('main.settings-workspace').waitFor({ state: 'visible' })
  await page.locator('[data-settings-tab="dev"]').click()
  await expect(page.getByRole('checkbox', { name: /^(后台工具|Background tools)$/ })).toHaveCount(0)
  await page.locator('[data-settings-tab="subagents"]').click()
  const subagentCapabilities = page.locator('.settings-subagent-editor').getByRole('group', { name: /^(能力|Capabilities)$/ })
  await expect(subagentCapabilities.locator('.ui-section-title')).toHaveText(/^(能力|Capabilities)$/)
  await expect(subagentCapabilities.getByRole('button', { name: /^(全开|Enable all)$/ })).toBeVisible()
  await expect(subagentCapabilities.getByRole('checkbox', { name: /^(技能|Skills)$/ })).toHaveCount(1)
  await subagentCapabilities.scrollIntoViewIfNeeded()
  assert.equal(await subagentCapabilities.evaluate((element) => globalThis.getComputedStyle(element).borderTopStyle), 'solid', 'The full capability editor must have a visible shared boundary.')
  if (process.env.ANAS_E2E_SUBAGENT_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_SUBAGENT_SCREENSHOT })
  await page.locator('[data-settings-tab="skills"]').click()
  await page.locator('.settings-skill-tree').waitFor({ state: 'visible' })
  const skillRows = page.locator('.settings-skill-tree-row')
  assert.ok(await skillRows.count() >= 4, 'Skills tree must show its built-in roots.')
  const skillRowHeights = await skillRows.evaluateAll((rows) => rows.slice(0, 12).map((row) => Math.round(row.getBoundingClientRect().height)))
  assert.deepEqual([...new Set(skillRowHeights)], [30], 'Skill tree item heights must remain fixed.')
  await page.locator('.sidebar-footer button').click()
  await page.locator('[data-agent-composer-input]').waitFor({ state: 'visible' })

  await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
  await page.locator('.project-details-action').filter({ hasText: /Edit|编辑/ }).click()
  const capabilityDialog = page.locator('.project-dialog')
  const duplicate = await page.evaluate(async () => {
    const result = await globalThis.gale.projects.create({ kind: 'simple_chat', name: 'E2E duplicate project', prompt: '' })
    if (result.status !== 'ok') throw new Error(JSON.stringify(result.error))
    return result.value
  })
  const projectName = capabilityDialog.getByRole('textbox', { name: /^(项目名称|Project name)$/ })
  const originalName = await projectName.inputValue()
  await projectName.fill(duplicate.name)
  await capabilityDialog.locator('button[type="submit"]').click()
  const errorNotice = page.locator('[data-sonner-toast][data-type="error"]').last()
  await expect(errorNotice).toContainText(duplicate.name)
  await expect(errorNotice).not.toContainText('Error invoking remote method')
  await errorNotice.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await expect(errorNotice).not.toBeVisible()
  await expect(capabilityDialog).toBeVisible()
  await expect(projectName).toHaveValue(duplicate.name)
  await projectName.fill(originalName)
  await page.evaluate((id) => globalThis.gale.projects.delete(id), duplicate.id)
  const codingMode = capabilityDialog.getByRole('checkbox', { name: /^(编码模式|Coding mode)$/ })
  await expect(codingMode).not.toBeChecked()
  await codingMode.check()
  if (process.env.ANAS_E2E_CODING_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CODING_SCREENSHOT })
  const advancedSettings = capabilityDialog.getByRole('checkbox', { name: /^(定制能力|Customize capabilities)$/ })
  await expect(advancedSettings).not.toBeChecked()
  await expect(capabilityDialog.getByRole('region', { name: /^(能力|Capabilities)$/ })).toHaveCount(0)
  await advancedSettings.check()
  const projectPrompt = capabilityDialog.getByRole('textbox', { name: /^(提示词|Prompt)$/ })
  await projectPrompt.fill('Follow this project instruction.')
  const promptBounds = await projectPrompt.boundingBox()
  const promptStyle = await projectPrompt.evaluate((element) => {
    const style = globalThis.getComputedStyle(element)
    return { minHeight: parseFloat(style.minHeight), lineHeight: parseFloat(style.lineHeight), radius: parseFloat(style.borderRadius), rows: element.rows }
  })
  assert.equal(promptStyle.rows, 2)
  assert.ok(Math.abs(promptStyle.minHeight - promptStyle.lineHeight * 2 - 20) < 1, 'Prompt minimum height must be two lines plus shared padding and borders.')
  assert.ok(promptStyle.radius > 0, 'Prompt must use shared rounded text field styling.')
  if (process.env.ANAS_E2E_PROJECT_PROMPT_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_PROJECT_PROMPT_SCREENSHOT })
  const folderBounds = await capabilityDialog.locator('.project-folder-add').boundingBox()
  assert.ok(promptBounds.y < folderBounds.y, 'The project prompt must appear before source folders.')
  await advancedSettings.uncheck()
  await expect(codingMode).toBeVisible()
  await expect(codingMode).toBeChecked()
  await codingMode.uncheck()
  await expect(projectPrompt).toHaveCount(0)
  await expect(capabilityDialog.getByRole('region', { name: /^(能力|Capabilities)$/ })).toHaveCount(0)
  await advancedSettings.check()
  await expect(projectPrompt).toHaveValue('Follow this project instruction.')
  const capabilityPanel = capabilityDialog.getByRole('region', { name: /^(能力|Capabilities)$/ })
  await expect(capabilityPanel).toBeVisible()
  const panelBounds = await capabilityPanel.boundingBox()
  const nameBounds = await codingMode.boundingBox()
  assert.ok(panelBounds.x > nameBounds.x + nameBounds.width, 'Advanced capabilities must appear beside project settings.')
  const profileToggle = capabilityDialog.getByRole('checkbox', { name: /^(资料|Profile)$/ })
  const environmentToggle = capabilityDialog.getByRole('checkbox', { name: /^(运行环境|Runtime environment information)$/ })
  const profileBounds = await profileToggle.boundingBox()
  const environmentBounds = await environmentToggle.boundingBox()
  assert.ok(Math.abs(profileBounds.y - environmentBounds.y) < 2, 'Direct capability toggles must share a row when space allows.')
  const togglePositions = await capabilityDialog.locator('.ui-grid-auto > .ui-checkbox-field input').evaluateAll((inputs) => inputs.map((input) => {
    const { x, y } = input.getBoundingClientRect()
    return { x, y }
  }))
  const firstRowColumns = togglePositions.filter((position) => Math.abs(position.y - togglePositions[0].y) < 2).map((position) => position.x)
  assert.ok(togglePositions.some((position) => position.y > togglePositions[0].y + 2), 'Capability toggles must wrap into multiple rows.')
  assert.ok(togglePositions.every((position) => firstRowColumns.some((x) => Math.abs(position.x - x) < 2)), 'Capability checkbox columns must align across rows.')
  const backgroundTools = capabilityDialog.getByRole('checkbox', { name: /^(后台工具|Background tools)$/ })
  await expect(capabilityDialog.locator('summary').filter({ hasText: /后台工具|Background tools/ })).toHaveCount(0)
  for (const name of ['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call']) {
    await expect(capabilityDialog.getByRole('checkbox', { name, exact: true })).toHaveCount(0)
  }
  await expect(backgroundTools).toBeChecked()
  await backgroundTools.click()
  await expect(backgroundTools).not.toBeChecked()
  await backgroundTools.press('Space')
  await expect(backgroundTools).toBeChecked()
  const restrictSubagents = capabilityDialog.getByRole('checkbox', { name: /^(限制子 Agent 能力|Limit subagent capabilities)$/ })
  await restrictSubagents.check()
  const enableAllBounds = await capabilityDialog.getByRole('button', { name: /^(全开|Enable all)$/ }).boundingBox()
  const restrictionBounds = await restrictSubagents.boundingBox()
  assert.ok(Math.abs(enableAllBounds.y + enableAllBounds.height / 2 - restrictionBounds.y - restrictionBounds.height / 2) < 3, 'Subagent restriction must share the enable/disable toolbar row.')
  assert.ok(restrictionBounds.x > enableAllBounds.x + enableAllBounds.width, 'Subagent restriction must be on the right of the toolbar.')
  await capabilityDialog.getByRole('button', { name: /^(全开|Enable all)$/ }).click()
  await expect(restrictSubagents).not.toBeChecked()
  await restrictSubagents.check()
  await capabilityDialog.locator('summary').filter({ hasText: /File read|文件读/ }).click()
  await capabilityDialog.getByRole('checkbox', { name: 'read_multiple_files', exact: true }).uncheck()
  await expect(capabilityDialog.getByRole('checkbox', { name: 'read_file', exact: true })).toBeChecked()
  const skillPicker = capabilityDialog.getByRole('combobox', { name: /^(技能选择|Skill selection)$/ })
  await skillPicker.click()
  await page.getByRole('option', { name: /^(自定义|Custom)$/ }).click()
  const skillToggleBounds = await capabilityDialog.getByRole('checkbox', { name: /^(技能|Skills)$/ }).boundingBox()
  const skillPickerBounds = await skillPicker.boundingBox()
  assert.ok(Math.abs(skillToggleBounds.y + skillToggleBounds.height / 2 - skillPickerBounds.y - skillPickerBounds.height / 2) < 3, `Skill mode must align with its capability toggle: ${JSON.stringify({ skillToggleBounds, skillPickerBounds })}`)
  assert.ok(skillPickerBounds.x > skillToggleBounds.x + skillToggleBounds.width, 'Skill mode must be on the right of its capability toggle.')
  const skillSearch = capabilityDialog.getByRole('searchbox', { name: /^(搜索技能|Search skills)$/ })
  await skillSearch.fill('search')
  await expect(skillPicker).toHaveClass('searchable-option-input')
  await expect(skillSearch).toHaveClass('ui-input')
  const searchStyle = await skillSearch.evaluate((element) => {
    const style = globalThis.getComputedStyle(element)
    return { radius: parseFloat(style.borderRadius), height: element.getBoundingClientRect().height }
  })
  assert.ok(searchStyle.radius > 0 && searchStyle.height >= 30, 'Skill search must use the shared rounded input styling.')
  if (process.env.ANAS_E2E_CAPABILITY_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CAPABILITY_SCREENSHOT })
  await skillPicker.click()
  await page.getByRole('option', { name: /^(使用默认|Use defaults)$/ }).click()
  await capabilityDialog.locator('button[type="submit"]').click()
  await expect(capabilityDialog).not.toBeVisible()
  const scopedProject = await page.evaluate(async () => (await globalThis.gale.projects.list()).find((project) => project.id === 'default-workspace'))
  assert.equal(scopedProject.restrictSubagents, true)
  assert.equal(scopedProject.advancedSettings, true)
  assert.equal(scopedProject.prompt, 'Follow this project instruction.')
  assert.equal(scopedProject.capabilities.backgroundTools, true)
  assert.equal(scopedProject.capabilities.toolMode, 'except')
  assert.equal(scopedProject.capabilities.tools.includes('read_multiple_files'), true)
  assert.equal(scopedProject.capabilities.tools.includes('read_file'), false)

  await page.locator('.new-chat').click()
  assert.equal(await page.locator('[data-agent-composer-input]').count(), 1)

  const accessTrigger = page.locator('.composer-access-trigger')
  assert.equal(await accessTrigger.isEnabled(), false, 'Tool access must stay disabled without a configured model.')

  const sidebar = page.locator('.app-sidebar')
  const resizeHandle = page.locator('.sidebar-resize-handle')
  const sidebarBox = await sidebar.boundingBox()
  const resizeHandleBox = await resizeHandle.boundingBox()
  assert.equal(Math.round(resizeHandleBox.width), 16, 'Sidebar resize target must remain 16 pixels wide.')
  assert.ok(
    Math.abs(resizeHandleBox.x - (sidebarBox.x + sidebarBox.width - 8)) <= 1,
    'Sidebar resize target must extend equally across both sides of the divider.'
  )
  const resizeHitTargets = await page.evaluate(({ leftX, rightX, y }) => {
    const hitsResizeHandle = (x) => Boolean(globalThis.document.elementFromPoint(x, y)?.closest('.sidebar-resize-handle'))
    return { left: hitsResizeHandle(leftX), right: hitsResizeHandle(rightX) }
  }, {
    leftX: sidebarBox.x + sidebarBox.width - 6,
    rightX: sidebarBox.x + sidebarBox.width + 6,
    y: resizeHandleBox.y + 100
  })
  assert.deepEqual(resizeHitTargets, { left: true, right: true }, 'Sidebar divider must respond on both sides.')
  await page.mouse.move(resizeHandleBox.x + resizeHandleBox.width / 2, resizeHandleBox.y + 100)
  await page.mouse.down()
  await page.mouse.move(resizeHandleBox.x + resizeHandleBox.width / 2 + 60, resizeHandleBox.y + 100, { steps: 4 })
  await page.mouse.up()
  persistedSidebarWidth = Math.round(sidebarBox.width + 60)
  await page.waitForFunction(async (expectedWidth) => (
    (await globalThis.gale.config.get()).settings.sidebarWidth === expectedWidth
  ), persistedSidebarWidth)
  assert.equal(Math.round((await sidebar.boundingBox()).width), persistedSidebarWidth)

  await page.evaluate(axeSource)
  const accessibility = await page.evaluate(() => globalThis.axe.run(globalThis.document, {
    rules: { 'color-contrast': { enabled: false } }
  }))
  const seriousViolations = accessibility.violations.filter((violation) => (
    violation.impact === 'critical' || violation.impact === 'serious'
  ))
  assert.deepEqual(seriousViolations, [], JSON.stringify(seriousViolations, null, 2))
  const rendererUrl = page.url()
  const popupDenied = await page.evaluate(() => (
    globalThis.open('anas-unexpected://popup') === null
  ))
  assert.equal(popupDenied, true, 'Unexpected popup navigation was not denied.')
  await page.evaluate(() => {
    globalThis.location.href = 'anas-unexpected://navigation'
  })
  await page.waitForTimeout(100)
  assert.equal(page.url(), rendererUrl, 'Unexpected main-frame navigation was not denied.')
  const unexpectedScriptExecuted = await page.evaluate(async () => {
    const marker = '__anasUnexpectedScriptExecuted'
    const script = globalThis.document.createElement('script')
    script.src = `data:text/javascript,globalThis.${marker}=true`
    const settled = new Promise((resolve) => {
      script.addEventListener('load', resolve, { once: true })
      script.addEventListener('error', resolve, { once: true })
    })
    globalThis.document.head.append(script)
    await settled
    script.remove()
    return globalThis[marker] === true
  })
  assert.equal(unexpectedScriptExecuted, false, 'Renderer CSP allowed an unexpected data script.')
  assert.equal(pageErrors.length, 0, `Renderer errors: ${pageErrors.map(String).join('\n')}`)
}

async function verifySkillSourceLayout(electronApplication) {
  await electronApplication.evaluate(({ ipcMain }) => {
    const roots = ['system', 'user', 'project'].map((kind) => ({
      id: kind, kind, name: `${kind} directory`, shortcutAlias: kind,
      path: `/skills/${kind}`, removable: false, available: true
    }))
    const skills = roots.map((root) => ({
      id: `${root.id}:search`, rootId: root.id, name: `${root.id}-search`, description: 'Search skill',
      modelAvailable: true, userAvailable: true, scriptAutoApprove: false, linked: false, dirPath: `${root.path}/search`,
      relativePath: 'search', source: root.kind, rootName: root.name, shortcutAlias: root.shortcutAlias
    }))
    ipcMain.removeHandler('skills:get')
    ipcMain.handle('skills:get', (_event, projectId) => ({
      scriptAutoApprove: false,
      roots: roots.filter((root) => projectId || root.kind !== 'project'),
      skills: skills.filter((skill) => projectId || skill.source !== 'project')
    }))
  })
  const page = await electronApplication.firstWindow()
  await page.reload()
  await page.locator('.sidebar-footer button').click()
  await page.locator('.app-menu-item').first().click()
  await page.locator('[data-settings-tab="skills"]').click()
  const systemRoot = page.locator('.settings-skill-tree-root').filter({ hasText: /System|系统/ })
  await systemRoot.click()
  await expect(page.locator('.settings-skill-tree-select').filter({ hasText: 'system-search' })).toBeVisible()
  await expect(page.locator('.settings-skill-tree-root').filter({ hasText: /Project|项目/ })).toHaveCount(0)
  await expect(systemRoot).toHaveClass(/active/)
  if (process.env.ANAS_E2E_SKILL_SOURCES_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_SKILL_SOURCES_SCREENSHOT })
  await page.locator('[data-settings-tab="subagents"]').click()
  const editor = page.locator('.settings-subagent-editor')
  await editor.getByRole('combobox', { name: /^(技能选择|Skill selection)$/ }).click()
  await page.getByRole('option', { name: /^(自定义|Custom)$/ }).click()
  for (const label of [/^(系统|System)\s/, /^(用户|User)\s/]) {
    await expect(editor.locator('strong').filter({ hasText: label })).toBeVisible()
  }
  await expect(editor.getByText('project directory', { exact: true })).toHaveCount(0)
  await expect(editor.getByText('project-search', { exact: true })).toHaveCount(0)
  const projectSkills = editor.getByRole('checkbox', { name: /^(项目技能|Project skills)$/ })
  await projectSkills.check()
  await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).subagents[0].capabilities.skills.project)).toBe(true)
  await projectSkills.scrollIntoViewIfNeeded()
  const checkboxColumns = await editor.locator('.ui-capability-skill input[type="checkbox"]').evaluateAll((inputs) => inputs.map((input) => input.getBoundingClientRect().x))
  assert.equal(checkboxColumns.length, 3)
  assert.ok(checkboxColumns.every((x) => Math.abs(x - checkboxColumns[0]) < 1), 'Project skills and individual skill checkboxes must share the same column.')
  await page.mouse.move(0, 0)
  if (process.env.ANAS_E2E_SKILL_SOURCES_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_SKILL_SOURCES_SCREENSHOT.replace(/\.png$/, '-capabilities.png') })
}

async function verifyCapabilityToolListLayout(electronApplication) {
  await electronApplication.evaluate(({ ipcMain }) => {
    const servers = [24, 100].map((count, index) => ({
      id: `layout-${index}`, index, name: `Layout MCP ${count}`, type: 'stdio', state: 'ready',
      toolCount: count, toolNames: Array.from({ length: count }, (_, tool) =>
        `mcp__layout_${index}__${tool === 0 ? 'long_tool_name_'.repeat(12) : `browser_action_${tool}`}`)
    }))
    ipcMain.removeHandler('mcp:status')
    ipcMain.handle('mcp:status', () => ({ checkedAt: '', servers, loaded: [], errors: [], tools: [], toolNames: [] }))
  })
  const page = await electronApplication.firstWindow()
  await page.reload()
  await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
  await page.locator('.project-details-action').filter({ hasText: /Edit|编辑/ }).click()
  const dialog = page.locator('.project-dialog')
  await dialog.getByRole('checkbox', { name: /^(定制能力|Customize capabilities)$/ }).check()

  async function verifyLists(editor, context) {
    for (const count of [24, 100]) {
      const group = editor.locator('[data-mcp-server-id]').filter({ hasText: `Layout MCP ${count}` })
      const toggle = group.getByRole('button', { name: `Layout MCP ${count}`, exact: true })
      const useAll = group.getByRole('checkbox', { name: /全部工具|All tools/ })
      await expect(useAll).toBeChecked()
      await expect(toggle).toHaveCount(0)
      await useAll.uncheck()
      await expect(toggle).toBeVisible()
      if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
      const list = group.locator('.ui-capability-list')
      const layout = await list.evaluate((element) => ({
        height: element.clientHeight, scrollHeight: element.scrollHeight,
        width: element.clientWidth, scrollWidth: element.scrollWidth,
        gap: parseFloat(globalThis.getComputedStyle(element).rowGap),
        rows: Array.from(element.children).map((row) => {
          const bounds = row.getBoundingClientRect()
          const checkbox = row.querySelector('input').getBoundingClientRect()
          const text = row.querySelector('code').getBoundingClientRect()
          return { top: bounds.top, bottom: bounds.bottom, height: bounds.height,
            contentHeight: Math.max(checkbox.height, text.height) }
        })
      }))
      assert.equal(layout.rows.length, count)
      assert.ok(layout.height <= 280, `${context}: tool list must remain height bounded.`)
      assert.ok(layout.scrollHeight > layout.height, `${context}: overflowing tools must scroll.`)
      assert.ok(layout.scrollWidth <= layout.width + 1, `${context}: long tool names must wrap inside the list.`)
      layout.rows.forEach((row, index) => {
        assert.ok(row.height >= row.contentHeight - 1, `${context}: tool row ${index} must not compress its contents.`)
        if (index) assert.ok(row.top >= layout.rows[index - 1].bottom + layout.gap - 1,
          `${context}: tool rows must preserve their gap without overlapping.`)
      })
      const last = list.getByRole('checkbox').last()
      await last.check()
      await expect(last).toBeChecked()
      await last.uncheck()
      await expect(last).not.toBeChecked()
      if (count === 24 && process.env.ANAS_E2E_TOOL_LIST_SCREENSHOT) {
        await list.evaluate((element) => { element.scrollTop = 0 })
        await page.screenshot({ path: process.env.ANAS_E2E_TOOL_LIST_SCREENSHOT.replace(/\.png$/, `-${context}.png`) })
      }
      await toggle.click()
      await expect(list).not.toBeVisible()
      await expect(useAll).toBeVisible()
      await useAll.check()
      await expect(toggle).toHaveCount(0)
      await expect(list).not.toBeVisible()
    }
  }
  await verifyLists(dialog, 'project')
  await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
  await page.locator('.sidebar-footer button').click()
  await page.locator('.app-menu-item').first().click()
  await page.locator('[data-settings-tab="subagents"]').click()
  await verifyLists(page.locator('.settings-subagent-editor'), 'subagent')
}

async function verifyThreadListLayout(electronApplication) {
  await electronApplication.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:threads:list')
    ipcMain.handle('agent:threads:list', () => ['idle', 'running'].map((status, index) => ({
      id: `layout-thread-${index}`, projectId: 'default-workspace', title: `Conversation ${index} with a very long title that must stay on one line`,
      status, pinned: index === 0, userTurnCount: 7, accessMode: 'read_only_allowed',
      createdAt: '2026-09-06T01:00:00Z', updatedAt: '2026-09-06T08:00:00Z'
    })))
  })
  const page = await electronApplication.firstWindow()
  await page.reload()
  const rows = page.locator('.thread-item')
  await expect(rows).toHaveCount(2)
  for (const row of await rows.all()) {
    const layout = await row.evaluate((element) => {
      const title = element.querySelector('.thread-name')
      const bounds = element.getBoundingClientRect()
      const titleBounds = title.getBoundingClientRect()
      const actionBounds = element.querySelector('.ui-list-item-action-wrap').getBoundingClientRect()
      return { height: bounds.height, titleHeight: titleBounds.height, actionInside: actionBounds.top >= bounds.top && actionBounds.bottom <= bounds.bottom,
        textWidth: title.querySelector('.ui-truncate').getBoundingClientRect().right, actionLeft: actionBounds.left,
        rows: globalThis.getComputedStyle(element.querySelector('.thread-open')).gridTemplateRows.split(' ').length }
    })
    assert.equal(layout.rows, 1, 'Thread entries must occupy exactly one grid row.')
    assert.ok(layout.height <= layout.titleHeight + 18, 'Thread entry must not retain metadata row space.')
    assert.ok(layout.actionInside && layout.textWidth <= layout.actionLeft, 'More action must fit without overlapping title text.')
    await expect(row.locator('time')).toHaveCount(0)
  }
  const runningStatus = rows.nth(1).locator('.thread-status-indicator')
  await expect(runningStatus.locator('svg')).toBeVisible()
  const statusBounds = await runningStatus.boundingBox()
  const titleBounds = await rows.nth(1).locator('.thread-name').boundingBox()
  assert.ok(Math.abs(statusBounds.y + statusBounds.height / 2 - titleBounds.y - titleBounds.height / 2) < 1, 'Running status and title must align on one line.')
  await rows.first().hover()
  await rows.first().getByRole('button', { name: /^(更多|More)$/ }).click()
  const menu = page.locator('.thread-action-menu')
  await expect(menu.locator('.ui-menu-description')).toHaveText(/7/)
  await expect(menu.locator('time')).toHaveAttribute('datetime', '2026-09-06T08:00:00Z')
  if (process.env.ANAS_E2E_THREAD_LIST_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_THREAD_LIST_SCREENSHOT })
  await page.keyboard.press('Escape')
}

async function verifyProjectModelSelection(electronApplication) {
  const page = await electronApplication.firstWindow()
  const fixture = await page.evaluate(async () => {
    const api = globalThis.gale.config
    await api.updateSettings({ language: 'en', theme: 'dark', newThreadModelSelection: 'prompt' })
    const snapshot = await api.saveModelProvider({
      name: 'E2E Models', protocol: 'openai_chat_completions', baseUrl: 'https://model-test.invalid/v1',
      apiKey: '', parameters: {}, modelListAuth: 'bearer'
    })
    const providerId = snapshot.providers.find((provider) => provider.name === 'E2E Models').id
    let config
    for (const displayName of ['Global Model', 'Project Model']) {
      config = await api.saveProviderModel({
        providerId, displayName, model: displayName.replaceAll(' ', '-'), parameters: {},
        parameterPresetMode: 'custom', defaultParameterPresetId: 'on',
        parameterPresets: [
          { id: 'on', name: 'Thinking on', parameters: { reasoning_effort: 'high' } },
          { id: 'off', name: 'Thinking off', parameters: { reasoning_effort: 'low' } }
        ],
        capabilities: { vision: true, toolUse: true }, stream: true,
        maxContextTokens: 128000, maxOutputTokens: 16000,
        contextCompressionThreshold: 0.8, contextCompressionEnabled: true
      })
    }
    const models = config.providers.find((provider) => provider.id === providerId).models
    const globalId = models.find((model) => model.displayName === 'Global Model').id
    const preferredId = models.find((model) => model.displayName === 'Project Model').id
    await api.selectDefaultModel(globalId)
    return { providerId, globalId, preferredId }
  })
  await page.reload()
  const composerModel = page.locator('form .composer-model-trigger')
  const composerReasoning = page.locator('form .composer-model-parameter-preset-trigger')
  const dialog = page.locator('.project-dialog')
  async function verifyModelHeading() {
    const row = dialog.locator('.ui-row-between').filter({ has: page.locator('.composer-model-selection-group') })
    const labelBox = await row.locator('.ui-field-label').boundingBox()
    const groupBox = await row.locator('.composer-model-selection-group').boundingBox()
    const rowBox = await row.boundingBox()
    assert.ok(Math.abs(groupBox.x + groupBox.width - rowBox.x - rowBox.width) < 1, 'Project model controls must align to the right edge.')
    assert.ok(Math.abs(labelBox.y + labelBox.height / 2 - groupBox.y - groupBox.height / 2) < 1, 'The content heading and model controls must share one vertically centered row.')
    assert.ok(groupBox.x >= labelBox.x + labelBox.width, 'Project model controls must not overlap the content heading.')
  }
  async function verifySegmentFocus(segment) {
    await expect(segment).toBeFocused()
    const focus = await segment.evaluate((element) => {
      const style = globalThis.getComputedStyle(element)
      return {
        focusVisible: element.matches(':focus-visible'),
        outlineStyle: style.outlineStyle,
        background: style.backgroundColor,
        textColor: style.color
      }
    })
    assert.equal(focus.outlineStyle, 'none', 'Model/reasoning segments must not retain the browser rectangular focus outline.')
    if (focus.focusVisible) {
      // Resolve theme tokens through the browser, including color-mix and non-RGB literals.
      const expected = await segment.evaluate((element) => {
        const sample = globalThis.document.createElement('span')
        sample.style.backgroundColor = 'var(--bg-hover)'
        sample.style.color = 'var(--text)'
        element.append(sample)
        const style = globalThis.getComputedStyle(sample)
        const colors = { background: style.backgroundColor, textColor: style.color }
        sample.remove()
        return colors
      })
      assert.equal(focus.background, expected.background, 'Keyboard focus must keep the shared segment background highlight.')
      assert.equal(focus.textColor, expected.textColor)
    }
  }
  await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
  await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
  await expect(dialog).toBeVisible()
  await page.locator('.ui-backdrop').click({ position: { x: 30, y: 300 } })
  await expect(dialog).toBeVisible()
  await dialog.locator('.composer-model-trigger').click()
  await page.getByRole('menuitemradio', { name: /^Project Model/ }).click()
  await expect(dialog.locator('.composer-model-parameter-preset-trigger')).toHaveText('Thinking on')
  await verifySegmentFocus(dialog.locator('.composer-model-trigger'))
  await verifyModelHeading()
  if (process.env.ANAS_E2E_PROJECT_SCREENSHOT) {
    await page.screenshot({ path: process.env.ANAS_E2E_PROJECT_SCREENSHOT.replace(/\.png$/, '-workspace.png') })
  }
  await dialog.locator('.ui-dialog-footer button').first().click()
  await expect(dialog).not.toBeVisible()
  await page.locator('.project-picker-trigger').click()
  await page.locator('.project-picker-item').last().click()
  await dialog.locator('input').first().fill('Model preference E2E')
  await page.locator('.ui-backdrop').click({ position: { x: 30, y: 300 } })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('input').first()).toHaveValue('Model preference E2E')
  await expect(dialog.locator('.composer-model-trigger')).toHaveText('Select model')
  await dialog.locator('.composer-model-trigger').click()
  await page.getByRole('menuitemradio', { name: /^Project Model/ }).click()
  await expect(dialog.locator('.composer-model-parameter-preset-trigger')).toHaveText('Thinking on')
  await dialog.locator('.composer-model-parameter-preset-trigger').click()
  await page.getByRole('menuitemradio', { name: 'Thinking off', exact: true }).click()
  await verifySegmentFocus(dialog.locator('.composer-model-parameter-preset-trigger'))
  await page.keyboard.press('Shift+Tab')
  const modelSegment = dialog.locator('.composer-model-trigger')
  await expect(modelSegment).toBeFocused()
  await expect(modelSegment).toHaveJSProperty('tabIndex', 0)
  await verifySegmentFocus(modelSegment)
  await page.keyboard.press('Enter')
  await expect(page.locator('.composer-model-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await verifySegmentFocus(modelSegment)
  const reasoningSegment = dialog.locator('.composer-model-parameter-preset-trigger')
  await reasoningSegment.click()
  await page.keyboard.press('Escape')
  await verifySegmentFocus(reasoningSegment)
  await modelSegment.click()
  await expect(page.locator('.composer-model-menu')).toBeVisible()
  await page.locator('.ui-backdrop').click({ position: { x: 30, y: 300 } })
  await expect(page.locator('.composer-model-menu')).not.toBeVisible()
  await expect(dialog).toBeVisible()
  // Dismissing either menu by clicking an input must not steal that input's focus.
  for (const segment of [modelSegment, reasoningSegment]) {
    await segment.click()
    const nameInput = dialog.locator('input').first()
    await nameInput.click({ position: { x: 15, y: 15 } })
    await expect(page.getByRole('menu')).not.toBeVisible()
    await expect(nameInput).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.type('!')
    await expect(nameInput).toHaveValue('Model preference E2E!')
    await page.keyboard.press('Backspace')
  }
  await modelSegment.focus()
  await verifyModelHeading()
  if (process.env.ANAS_E2E_PROJECT_SCREENSHOT) {
    await page.screenshot({ path: process.env.ANAS_E2E_PROJECT_SCREENSHOT })
  }
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog).not.toBeVisible()
  await expect(composerModel).toHaveText('Project Model')
  await expect(composerReasoning).toHaveText('Thinking off')
  const project = await page.evaluate(async () => (
    (await globalThis.gale.projects.list()).find((item) => item.name === 'Model preference E2E')
  ))
  assert.equal(project.modelConfigId, fixture.preferredId)
  assert.equal(project.modelParameterPresetId, 'off')
  await page.locator('.project-picker-trigger').click()
  await page.locator('.project-picker-item').filter({ hasText: 'Default Workspace' }).click()
  await expect(composerModel).toHaveText('Select model')
  await page.locator('.project-picker-trigger').click()
  await page.locator('.project-picker-item').filter({ hasText: 'Model preference E2E' }).click()
  await expect(composerModel).toHaveText('Project Model')
  await expect(composerReasoning).toHaveText('Thinking off')
  const projectGroup = page.locator('.project-thread-group').filter({ hasText: 'Model preference E2E' })
  async function editProject() {
    await projectGroup.locator('.project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    await expect(dialog).toBeVisible()
  }
  // A manual draft choice survives a reload, but a fresh conversation uses the project preference again.
  await composerModel.click()
  await page.getByRole('menuitemradio', { name: /^Global Model/ }).click()
  await expect.poll(() => page.evaluate(async () => (await globalThis.gale.agent.workspace.get()).modelConfigId))
    .toBe(fixture.globalId)
  await page.reload()
  await expect(composerModel).toHaveText('Global Model')
  await projectGroup.locator('.project-thread-new-chat').click()
  await expect(composerModel).toHaveText('Project Model')
  await expect(composerReasoning).toHaveText('Thinking off')

  await editProject()
  await dialog.locator('.composer-model-parameter-preset-trigger').click()
  await page.getByRole('menuitem', { name: 'Not selected', exact: true }).click()
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog).not.toBeVisible()
  await expect(composerReasoning).toHaveText('Thinking off')
  await projectGroup.locator('.project-thread-new-chat').click()
  await expect(composerReasoning).toHaveText('Not selected')
  await editProject()
  await dialog.locator('.composer-model-trigger').click()
  await page.getByRole('menuitemradio', { name: 'Not selected', exact: true }).click()
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog).not.toBeVisible()
  await projectGroup.locator('.project-thread-new-chat').click()
  await expect(composerModel).toHaveText('Select model')

  // Restore the preference, then remove its model; prompt/default paths must remain unchanged.
  await editProject()
  await dialog.locator('.composer-model-trigger').click()
  await page.getByRole('menuitemradio', { name: /^Project Model/ }).click()
  await dialog.locator('button[type="submit"]').click()
  await expect(dialog).not.toBeVisible()
  await projectGroup.locator('.project-thread-new-chat').click()
  await page.evaluate(async ({ providerId, preferredId }) => {
    await globalThis.gale.config.deleteProviderModel(providerId, preferredId)
  }, fixture)
  await page.reload()
  await expect(composerModel).toHaveText('Select model')
  await page.evaluate(async () => globalThis.gale.config.updateSettings({ newThreadModelSelection: 'default' }))
  await page.reload()
  await projectGroup.locator('.project-thread-new-chat').click()
  await expect(composerModel).toHaveText('Global Model')
}

async function verifyCodingMode(electronApplication) {
  const page = await electronApplication.firstWindow()
  for (const language of ['zh-CN', 'en']) {
    await page.evaluate(async (language) => globalThis.gale.config.updateSettings({ language }), language)
    await page.reload()
    const group = page.locator('.project-thread-group[data-default-workspace]')
    const dialog = page.locator('.project-dialog')
    const open = async () => {
      await group.locator('.project-thread-more').click()
      await page.locator('.project-details-action').filter({ hasText: /Edit|编辑/ }).click()
    }
    const mode = dialog.getByRole('checkbox', { name: language === 'en' ? 'Coding mode' : '编码模式', exact: true })
    const readMode = () => page.evaluate(async () => (await globalThis.gale.projects.list()).find((project) => project.id === 'default-workspace').codingMode)
    const verifyPreviews = async (codingMode) => {
      await open()
      const preview = page.locator('.settings-code-preview-dialog')
      for (const [label, marker] of [
        [/^(压缩提示词|Compression prompt)$/, 'Coding continuation handoff:'],
        [/^(完整提示词|Full prompt)$/, '<coding_instruction>']
      ]) {
        await dialog.getByRole('button', { name: label }).click()
        const content = preview.locator('pre')
        await expect(content).toBeVisible()
        if (codingMode) await expect(content).toContainText(marker)
        else await expect(content).not.toContainText(marker)
        if (codingMode && marker === 'Coding continuation handoff:' && process.env.ANAS_E2E_PROMPT_PREVIEW_SCREENSHOT) {
          await page.screenshot({ path: process.env.ANAS_E2E_PROMPT_PREVIEW_SCREENSHOT.replace(/\.png$/, `-${language}.png`) })
        }
        await preview.getByRole('button', { name: /^(关闭|Close)$/ }).click()
        await expect(preview).not.toBeVisible()
      }
      await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
      await expect(dialog).not.toBeVisible()
    }
    await open()
    await expect(mode).not.toBeChecked()
    await mode.check()
    await dialog.getByRole('checkbox', { name: /^(定制能力|Customize capabilities)$/ }).uncheck()
    if (process.env.ANAS_E2E_CODING_SCREENSHOT) {
      await page.screenshot({ path: process.env.ANAS_E2E_CODING_SCREENSHOT.replace(/\.png$/, `-${language}.png`) })
    }
    await dialog.locator('button[type="submit"]').click()
    await expect(dialog).not.toBeVisible()
    assert.equal(await readMode(), true)
    await verifyPreviews(true)
    await open()
    await expect(mode).toBeChecked()
    await mode.uncheck()
    await dialog.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
    assert.equal(await readMode(), true, 'Cancel must not persist the draft mode.')
    await open()
    await expect(mode).toBeChecked()
    await mode.uncheck()
    await dialog.locator('button[type="submit"]').click()
    await expect(dialog).not.toBeVisible()
    assert.equal(await readMode(), false)
    await verifyPreviews(false)
  }
}

async function verifyPatchRestoreApproval(electronApplication) {
  const paths = ['/project/中文 文件.ts', '/outside/docs/another-file.md']
  await electronApplication.evaluate(({ ipcMain }, paths) => {
    const now = new Date().toISOString()
    const thread = { id: 'patch-review', projectId: 'default-workspace', title: 'Batch restore review',
      status: 'interrupted', accessMode: 'strict_approval', pinned: false, userTurnCount: 1, createdAt: now, updatedAt: now }
    const snapshot = { thread, pendingRun: { id: 'patch-run', threadId: thread.id, status: 'interrupted', startedAt: now },
      messages: [], todos: [], activities: [], messageWindow: { startIndex: 0, shown: 0, total: 0, remaining: 0 },
      interrupts: [{ id: 'restore-review', approvalGeneration: 'review-generation', value: {
        actionRequests: [{ name: 'restore_file_edit', args: { operation_id: 'original-operation', request_id: 'original-request' } }]
      }, pathPreviews: paths.map((absolutePath, index) => ({ actionIndex: 0, locator: ['targets', index, 'path'], absolutePath, source: 'resolved' })) }] }
    for (const [channel, handler] of [
      ['agent:threads:list', () => [thread]], ['agent:threads:get', () => snapshot],
      ['agent:workspace:get', () => ({ mode: 'thread', threadId: thread.id })]
    ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
  }, paths)
  const page = await electronApplication.firstWindow()
  await page.reload()
  const dialog = page.locator('.agent-approval')
  await expect(dialog).toBeVisible()
  for (const path of paths) await expect(dialog.locator('pre')).toContainText(path)
  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { fits: rect.left >= 0 && rect.top >= 0 && rect.right <= globalThis.innerWidth && rect.bottom <= globalThis.innerHeight,
      overflow: element.scrollWidth > element.clientWidth + 1,
      buttons: Array.from(element.querySelectorAll('button')).map((button) => ({ width: button.clientWidth, height: button.clientHeight })) }
  })
  assert.equal(geometry.fits, true, 'Batch approval must fit the window.')
  assert.equal(geometry.overflow, false, 'Batch approval must not overflow horizontally.')
  assert.ok(geometry.buttons.every((button) => button.width > 40 && button.height > 20))
  if (process.env.ANAS_E2E_PATCH_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_PATCH_SCREENSHOT })
}

async function verifyRecordedChanges(electronApplication) {
  const directory = await mkdtemp(join(tmpdir(), 'anas-recorded-panel-e2e-'))
  try {
    await verifyRoundChangesInApplication(electronApplication, directory)
    const page = await electronApplication.firstWindow(), panel = page.getByRole('tabpanel')
    const geometry = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { fits: rect.left >= -1 && rect.top >= -1 && rect.right <= globalThis.innerWidth + 1 && rect.bottom <= globalThis.innerHeight + 1,
        bounds: rect.toJSON(), viewport: [globalThis.innerWidth, globalThis.innerHeight],
        overflow: element.scrollWidth > element.clientWidth + 1 }
    })
    if (!geometry.fits && process.env.ANAS_E2E_TITLEBAR_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_TITLEBAR_SCREENSHOT })
    assert.equal(geometry.fits, true, `Recorded changes panel must fit the window: ${JSON.stringify(geometry)}`)
    assert.equal(geometry.overflow, false, 'Recorded changes panel must not overflow horizontally.')
    await verifyWorkspacePanelTitlebar(electronApplication)
    if (process.env.ANAS_E2E_CHANGES_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CHANGES_SCREENSHOT })
    await page.getByRole('tablist').getByRole('button', { name: /^(关闭|Close) / }).click()
    await expect(panel).not.toBeVisible()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ diffFoldUnchanged: true, diffWordWrap: false }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function verifyWorkspacePanelTitlebar(electronApplication) {
  if (process.platform !== 'win32') return
  const page = await electronApplication.firstWindow()
  const original = await electronApplication.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return { bounds: win.getBounds(), zoom: win.webContents.getZoomFactor() }
  })
  const originalSettings = await page.evaluate(async () => {
    const { settings } = await globalThis.gale.config.get()
    return { workspacePanelWidth: settings.workspacePanelWidth, fontSize: settings.fontSize }
  })
  const header = page.locator('.workspace-panels-titlebar')
  const tabs = page.getByRole('tablist')
  const maximize = header.getByRole('button', { name: /^(展开右栏以占满对话区|Expand right workspace to fill conversation area)$/ })
  const resize = page.getByRole('separator', { name: /^(调整右侧工作区宽度|Resize right workspace)$/ })
  const measure = () => header.evaluate((element) => {
    const rect = (target) => {
      const { x, y, width, height, right, bottom } = target.getBoundingClientRect()
      return { x, y, width, height, right, bottom }
    }
    const safe = navigator.windowControlsOverlay.getTitlebarAreaRect()
    const actions = element.querySelector('.ui-tab-workspace-actions')
    const tabList = element.querySelector('[role="tablist"]')
    const tabBounds = tabList.getBoundingClientRect()
    return {
      header: rect(element), tabs: rect(element.querySelector('.ui-tab-workspace-tabs')), actions: rect(actions),
      safe: { right: safe.right, bottom: safe.bottom, width: safe.width },
      buttons: [...element.querySelectorAll('button')].map((button) => {
        const bounds = rect(button)
        // Scrolled-out tab buttons do not occupy the native caption area.
        return tabList.contains(button)
          ? { ...bounds, x: Math.max(bounds.x, tabBounds.x), right: Math.min(bounds.right, tabBounds.right) }
          : bounds
      }).filter((button) => button.right > button.x)
    }
  })
  function verifySafeArea(layout) {
    assert.ok(layout.safe.width > 0, 'Native titlebar geometry must be available.')
    assert.ok(layout.buttons.every((button) => button.y >= layout.safe.bottom - 1 || button.right <= layout.safe.right + 1), `Panel controls must stay outside native caption buttons: ${JSON.stringify(layout)}`)
    assert.ok(layout.tabs.right <= layout.header.right + 1, 'The tab strip must stay inside the panel.')
  }
  try {
    await electronApplication.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(2100, 1000))
    await page.evaluate(() => globalThis.gale.config.updateSettings({ fontSize: 14 }))
    const collapsedActivities = page.locator('.agent-activity-range-toggle[aria-expanded="false"]')
    if (await collapsedActivities.count()) await collapsedActivities.last().click()
    await page.locator('[data-agent-subagent-trigger][data-agent-subagent-id="fixture-child"]').first().click()
    await page.getByRole('button', { name: /^(文件改动|File changes)$/ }).click()
    await expect(tabs.getByRole('tab')).toHaveCount(2)
    for (const zoom of [1, 0.5, 0.8, 1.5]) {
      await electronApplication.evaluate(({ BrowserWindow }, zoom) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(zoom), zoom)
      await expect(resize).toBeVisible()
      await resize.press('End')
      await expect.poll(async () => { const m = await measure(); return Math.abs(m.tabs.y - m.actions.y) < 1 }).toBe(true)
      const wide = await measure()
      verifySafeArea(wide)
      await resize.press('Home')
      await expect.poll(async () => { const m = await measure(); return m.tabs.y >= m.actions.bottom - 1 }).toBe(true)
      const narrow = await measure()
      verifySafeArea(narrow)
      const resizeBounds = await resize.boundingBox()
      const panelBounds = await page.locator('.workspace-panels').boundingBox()
      assert.ok(resizeBounds.x >= panelBounds.x - 1 && resizeBounds.x + resizeBounds.width <= panelBounds.x + panelBounds.width,
        'The panel resize hit area must stay inside its pane, leaving the adjacent conversation scrollbar available.')
      assert.ok(Math.abs(narrow.actions.x - wide.actions.x) < 1 && Math.abs(narrow.actions.y - wide.actions.y) < 1, 'Panel actions must not move when tabs wrap.')
      await expect(tabs.getByRole('tab', { name: /文件改动|File changes/ })).toHaveAttribute('aria-selected', 'true')
      if (zoom === 1 && process.env.ANAS_E2E_TITLEBAR_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_TITLEBAR_SCREENSHOT })
    }
    await electronApplication.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1))
    await maximize.click()
    await expect.poll(async () => { const m = await measure(); return Math.abs(m.tabs.y - m.actions.y) < 1 }).toBe(true)
    verifySafeArea(await measure())
    await header.getByRole('button', { name: /^(还原右栏宽度|Restore right workspace width)$/ }).click()
    await expect.poll(async () => { const m = await measure(); return m.tabs.y >= m.actions.bottom - 1 }).toBe(true)
    await expect(page.getByRole('button', { name: /^(收起右侧工作区|Hide right workspace)$/ })).toHaveCount(1)
    await header.getByRole('button', { name: /^(收起右侧工作区|Hide right workspace)$/ }).click()
    await expect(header).not.toBeVisible()
    const opener = page.getByRole('button', { name: /^(展开右侧工作区|Show right workspace)$/ })
    await expect(opener).toBeFocused()
    const aligned = await opener.evaluate((button) => {
      const topbar = button.closest('.topbar')
      return Math.abs(button.getBoundingClientRect().right - (topbar.getBoundingClientRect().right - parseFloat(globalThis.getComputedStyle(topbar).paddingRight))) < 1
    })
    assert.ok(aligned, 'The collapsed panel opener must sit at the right edge of the main toolbar.')
    await opener.click()
    await expect(header).toBeVisible()
    await expect(opener).toHaveCount(0)
    await tabs.getByRole('tab', { name: /Fixture child/ }).focus()
    await page.keyboard.press('ArrowLeft')
    await expect(tabs.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true')
    await tabs.getByRole('button', { name: /^(关闭|Close) Fixture child/ }).click()
    await expect(tabs.getByRole('tab')).toHaveCount(1)
  } finally {
    await page.evaluate((settings) => globalThis.gale.config.updateSettings(settings), originalSettings)
    await electronApplication.evaluate(({ BrowserWindow }, original) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.webContents.setZoomFactor(original.zoom)
      win.setBounds(original.bounds)
    }, original)
  }
}

async function verifyGitChanges(electronApplication) {
  const page = await electronApplication.firstWindow()
  // Expanded diff coverage needs a genuinely wide workspace, independent of
  // the preceding tests' saved sidebar width and font size.
  await electronApplication.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(2100, 1000))
  const editor = page.locator('[data-agent-composer-input]')
  await editor.focus()
  await page.getByRole('button', { name: /^(文件改动|File changes)$/ }).click()
  const panel = page.getByRole('tabpanel')
  await expect(panel.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20000 })
  await expect(panel.locator('.monaco-diff-editor .view-lines').last()).toContainText('Working tree edit')
  await expect(panel.locator('.ui-diff-file')).toContainText('greeting.txt')
  await verifyReadonlyDiff(electronApplication, page)
  const geometry = await panel.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { fits: rect.left >= -1 && rect.top >= -1 && rect.right <= globalThis.innerWidth + 1 && rect.bottom <= globalThis.innerHeight + 1,
      overflow: element.scrollWidth > element.clientWidth + 1 }
  })
  assert.equal(geometry.fits, true, 'Git changes panel must fit the window.')
  assert.equal(geometry.overflow, false, 'Git changes panel must not overflow horizontally.')
  if (process.env.ANAS_E2E_GIT_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_GIT_SCREENSHOT })
  await panel.getByRole('button', { name: /^(比较方式|Comparison)$/ }).click()
  await page.getByRole('menuitemradio', { name: /^(比较基准 → 当前提交|Base → current commit)$/ }).click()
  await expect(panel).toContainText(/此范围内没有 Git 改动|No Git changes in this scope/)
  await page.getByRole('tablist').getByRole('button', { name: /^(关闭|Close) / }).click()
  await expect(panel).not.toBeVisible()
  await expect(editor).toBeFocused()
}

async function verifyCodeReview(electronApplication) {
  const page = await electronApplication.firstWindow()
  const modelConfigId = await page.evaluate(async () => (await globalThis.gale.config.get()).providers.flatMap((provider) => provider.models).find((model) => model.capabilities.toolUse)?.id)
  assert.ok(modelConfigId, 'The review fixture requires an explicit tool-capable model.')
  await electronApplication.evaluate(({ ipcMain }, modelConfigId) => {
    const now = new Date().toISOString(), version = 'a'.repeat(64)
    const thread = { id: 'review-ui', projectId: 'default-workspace', modelConfigId, title: 'Code review', status: 'idle', accessMode: 'read_only_allowed',
      pinned: false, userTurnCount: 1, createdAt: now, updatedAt: now }
    const scope = { id: 'b'.repeat(64), projectId: thread.projectId, capturedAt: now, description: 'Recorded changes / 已记录改动 · greeting.ts',
      request: { kind: 'recorded', threadId: thread.id, runId: 'changes-run', version, target: 'recorded' }, limitations: [],
      files: [{ id: 'file-1', path: '/project/src/greeting.ts', before: [{ start: 1, end: 1 }], after: [{ start: 1, end: 1 }],
        patch: '--- a/greeting.ts\n+++ b/greeting.ts\n@@ -1 +1 @@\n-return name || "Guest"\n+return name.trim()\n' }] }
    const review = { snapshot: scope, report: { scope_id: scope.id, summary: '发现 1 个需要处理的问题。', limitations: ['尚未运行完整测试。'], findings: [
      { priority: 'P2', title: '空名称失去默认问候', file_id: 'file-1', side: 'after', start_line: 1, end_line: 1,
        condition: '调用方传入空字符串时。', impact: '界面显示空白问候，而不是默认名称。', evidence: '旧实现会返回 Guest；修改后 trim() 返回空字符串。' }
    ] }, locations: [{ valid: true }] }
    const prompt = `Review the captured code changes below.\n\nScope: ${scope.description}\n\n${scope.files[0].patch}`
    globalThis.__anasReviewPrompt = prompt
    const snapshot = { thread, messages: [
      { id: 'review-input', role: 'user', runId: 'review-run', content: [{ type: 'text', text: prompt }] },
      { id: 'review-result', role: 'assistant', runId: 'review-run', codeReview: review,
        content: [{ type: 'text', text: review.report.summary }] }
    ], todos: [], activities: [], interrupts: [], messageWindow: { startIndex: 0, shown: 2, total: 2, remaining: 0 } }
    globalThis.__anasReviewSubmission = undefined
    for (const [channel, handler] of [
      ['agent:threads:list', () => [thread]], ['agent:threads:get', () => snapshot],
      ['agent:workspace:get', () => ({ mode: 'thread', threadId: thread.id })],
      ['agent:runs:recover', (_event, threadId) => {
        if (threadId !== thread.id) throw new Error('Unexpected conversation in review fixture recovery')
        return false
      }],
      ['agent:messages:prepareEdit', (_event, input) => {
        if (input.threadId !== thread.id || input.messageId !== 'review-input') throw new Error('Unexpected review edit scope')
        snapshot.messages = []
        snapshot.messageWindow = { startIndex: 0, shown: 0, total: 0, remaining: 0 }
        return { snapshot, attachments: [] }
      }],
      ['agent:runs:submit', (_event, input) => {
        globalThis.__anasReviewSubmission = input
        return { thread, run: { id: 'next-review', threadId: thread.id, operation: 'agent', status: 'completed', createdAt: now, updatedAt: now } }
      }]
    ]) { ipcMain.removeHandler(channel); ipcMain.handle(channel, handler) }
  }, modelConfigId)
  await page.reload()
  const prompt = await electronApplication.evaluate(() => globalThis.__anasReviewPrompt)
  const userMessage = page.locator('[data-message-id="review-input"]')
  await expect(userMessage).toBeVisible()
  assert.equal(await userMessage.locator('.bubble > p').textContent(), prompt, 'The entire review prompt and diff must be visible without a title substitution.')
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { globalThis.__anasReviewCopied = text }
    } })
  })
  await userMessage.locator('.bubble').hover()
  await userMessage.getByRole('button', { name: /^(复制|Copy)$/ }).click()
  assert.equal(await page.evaluate(() => globalThis.__anasReviewCopied), prompt, 'Copy must use the full review message.')
  await expect(page.getByText('[P2] 空名称失去默认问候')).toBeVisible()
  const captured = page.locator('summary').filter({ hasText: /查看审核时的差异|View captured diff/ })
  await captured.click()
  await expect(page.locator('pre').filter({ hasText: '+return name.trim()' }).first()).toBeVisible()
  if (process.env.ANAS_E2E_REVIEW_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_REVIEW_SCREENSHOT })
  const editor = page.locator('[data-agent-composer-input]')
  await editor.fill('保留的草稿')
  await page.getByRole('button', { name: /^(文件改动|File changes)$/ }).click()
  const panel = page.getByRole('tabpanel')
  await expect(panel.getByRole('button', { name: /^(审核所选范围|Review selected scope)$/ })).toBeEnabled()
  await panel.getByRole('button', { name: /^(审核所选范围|Review selected scope)$/ }).click()
  await expect(panel).toBeVisible()
  await expect.poll(() => electronApplication.evaluate(() => Boolean(globalThis.__anasReviewSubmission))).toBe(true)
  const submission = await electronApplication.evaluate(() => globalThis.__anasReviewSubmission)
  assert.equal(submission.review.kind, 'git')
  assert.equal(submission.review.scope, 'workspace')
  assert.match(submission.review.version, /^[a-f0-9]{64}$/)
  assert.equal(submission.attachments.length, 0)
  await expect(editor).toHaveValue('保留的草稿')
  await userMessage.locator('.bubble').hover()
  await userMessage.getByRole('button', { name: /^(编辑|Edit)$/ }).click()
  await page.getByRole('alertdialog').getByRole('button', { name: /^(编辑|Edit)$/ }).click()
  await expect(editor).toHaveValue(prompt)
  if (process.env.ANAS_E2E_REVIEW_EDIT_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_REVIEW_EDIT_SCREENSHOT })
}

async function main() {
  if (process.argv.includes('--skill-approval-only')) {
    await verifySkillApproval(launchApplication)
    return
  }
  if (process.argv.includes('--attachment-previews-only')) {
    await verifyAttachmentPreviews(launchApplication)
    return
  }
  if (process.argv.includes('--model-selection-only')) {
    await verifyModelSelection(launchApplication)
    return
  }
  if (process.argv.includes('--custom-tools-only')) {
    await verifyCustomTools(launchApplication)
    return
  }
  if (process.argv.includes('--capabilities-only')) {
    await verifyDefaultCapabilities(launchApplication)
    return
  }
  if (process.argv.includes('--project-model-picker-only')) {
    await verifyProjectModelPicker(launchApplication)
    return
  }
  if (process.argv.includes('--help-only')) {
    await verifyHelpDocuments(launchApplication)
    return
  }
  if (process.argv.includes('--settings-only')) {
    await verifyGlobalSettings(launchApplication)
    return
  }
  if (process.argv.includes('--storage-only')) {
    if (packagedExecutable) throw new Error('The controlled storage probe requires the local built main process.')
    await verifyCurrentStorage(repositoryRoot, electronExecutable)
    return
  }
  if (process.argv.includes('--tool-arguments-only')) {
    await verifyToolArguments(launchApplication)
    return
  }
  if (process.argv.includes('--round-changes-only')) {
    await verifyRoundChanges(launchApplication)
    return
  }
  if (process.argv.includes('--git-panel-only')) {
    await verifyGitPanelStates(launchApplication)
    return
  }
  if (process.argv.includes('--startup-only')) {
    if (packagedExecutable) throw new Error('The controlled startup probe requires the local built main process.')
    await verifyEnvironmentStartup(repositoryRoot, electronExecutable)
    return
  }
  if (process.argv.includes('--pty-only')) {
    await verifyPtyLifecycle(launchApplication)
    return
  }
  if (!process.argv.includes('--changes-only')) {
    await verifyDefaultCapabilities(launchApplication)
    await verifyGlobalSettings(launchApplication)
    await verifyCustomTools(launchApplication)
    await verifySkillApproval(launchApplication)
    await verifyHelpDocuments(launchApplication)
    await verifyAttachmentPreviews(launchApplication)
  }
  if (!packagedExecutable && !process.argv.includes('--changes-only')) await verifyEnvironmentStartup(repositoryRoot, electronExecutable)
  const testHome = await mkdtemp(join(tmpdir(), 'anas-electron-e2e-'))
  let electronApplication
  try {
    const workspace = join(testHome, 'workspace')
    const timestamp = new Date().toISOString()
    await mkdir(workspace, { recursive: true })
    const git = (...args) => promisify(execFile)('git', args, { cwd: workspace })
    await git('init', '-b', 'main')
    await git('config', 'user.name', 'Anas E2E')
    await git('config', 'user.email', 'e2e@example.invalid')
    await writeFile(join(workspace, 'greeting.txt'), 'Initial greeting\n')
    await git('add', '--', 'greeting.txt')
    await git('commit', '-m', 'Initial fixture')
    await writeFile(join(workspace, 'greeting.txt'), 'Working tree edit\n')
    await writeFile(join(testHome, 'projects.json'), `${JSON.stringify({
      version: 4,
      projects: [{
        id: 'default-workspace',
        kind: 'workspace',
        name: 'Default Workspace',
        pinned: false,
        collapsed: false,
        sourceFolders: [workspace],
        capabilities: structuredClone(defaultCapabilities),
        restrict_subagents: defaultRestrictSubagents,
        advanced_settings: false,
        coding_mode: false,
        prompt: '',
        createdAt: timestamp,
        updatedAt: timestamp
      }]
    }, null, 2)}\n`, 'utf8')
    electronApplication = await launchApplication(testHome)
    if (process.argv.includes('--changes-only')) {
      await verifyRecordedChanges(electronApplication)
      await verifyGitChanges(electronApplication)
      await verifyCodeReview(electronApplication)
      console.log('Unified changes Electron E2E passed: round/current contents, shared tabs with subagents, native titlebar geometry, Git diff controls, and review targets.')
      return
    }
    await verifyApplication(electronApplication)
    await electronApplication.close()
    electronApplication = await launchApplication(testHome)
    await verifyApplication(electronApplication, true)
    await verifyProjectModelSelection(electronApplication)
    await verifyProjectPreviews(electronApplication)
    await verifyThreadListLayout(electronApplication)
    await verifySkillSourceLayout(electronApplication)
    await verifyCapabilityToolListLayout(electronApplication)
    await verifyCodingMode(electronApplication)
    await verifyPatchRestoreApproval(electronApplication)
    await verifyRecordedChanges(electronApplication)
    await verifyGitChanges(electronApplication)
    await verifyCodeReview(electronApplication)
    console.log('Electron E2E smoke passed: sandbox, CSP, navigation guards, startup, speech input focus/IPC, menu focus, settings, thread entry, sidebar resize, restart, and project model/reasoning preferences.')
  } finally {
    await electronApplication?.close().catch(() => undefined)
    await rm(testHome, { recursive: true, force: true })
  }
  await verifyPtyLifecycle(launchApplication)
  await verifyToolArguments(launchApplication)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
