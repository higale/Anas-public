const assert = require('node:assert/strict')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

async function verifyDefaultCapabilities(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-default-capabilities-'))
  let application
  try {
    application = await launchApplication(home)
    let page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.locator('[data-agent-composer-input]').waitFor()
    const original = await page.evaluate(async () => {
      const api = globalThis.gale
      await api.config.updateSettings({ language: 'en' })
      await api.config.updateProfile({ assistant: { instructions: 'CAPABILITY_PROFILE_MARKER' } })
      const providerConfig = await api.config.saveModelProvider({ name: 'Preview', protocol: 'openai_chat_completions',
        baseUrl: 'https://preview.invalid/v1', apiKey: '', parameters: {}, modelListAuth: 'bearer' })
      const provider = providerConfig.providers.find(item => item.name === 'Preview')
      const configured = await api.config.saveProviderModel({ providerId: provider.id, displayName: 'Preview', model: 'preview', parameters: {},
        parameterPresetMode: 'none', capabilities: { vision: true, toolUse: true }, stream: true,
        maxContextTokens: 128000, maxOutputTokens: 16000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
      await api.config.selectDefaultModel(configured.providers[0].models[0].id)
      return { project: (await api.projects.list()).find(item => item.id === 'default-workspace'),
        subagents: configured.subagents }
    })
    await page.reload()
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="capabilities"]').click()
    const section = page.locator('.settings-section')
    await section.getByRole('checkbox', { name: 'Profile', exact: true }).uncheck()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).defaultCapabilities.capabilities.profile)).toBe(false)
    await section.getByRole('checkbox', { name: 'Limit subagent capabilities', exact: true }).check()
    await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).defaultCapabilities.restrictSubagents)).toBe(true)
    assert.equal(JSON.parse(await readFile(join(home, 'config', 'capabilities.json'), 'utf8')).profile, false)
    const previews = await page.evaluate(async () => {
      const api = globalThis.gale
      const config = await api.config.get()
      const project = (await api.projects.list()).find(item => item.id === 'default-workspace')
      const inherited = await api.agent.context.preview({ projectId: project.id, project: { ...project, advancedSettings: false }, settings: config.settings })
      const custom = await api.agent.context.preview({ projectId: project.id,
        project: { ...project, advancedSettings: true, capabilities: { ...project.capabilities, profile: true } }, settings: config.settings })
      return { inherited: inherited.content.includes('CAPABILITY_PROFILE_MARKER'), custom: custom.content.includes('CAPABILITY_PROFILE_MARKER'),
        project: (await api.projects.list()).find(item => item.id === project.id), subagents: config.subagents }
    })
    assert.equal(previews.inherited, false)
    assert.equal(previews.custom, true)
    assert.deepEqual(previews.project, original.project)
    assert.deepEqual(previews.subagents, original.subagents)
    if (process.env.ANAS_E2E_CAPABILITIES_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_CAPABILITIES_SCREENSHOT })
    await application.close()
    application = await launchApplication(home)
    page = await application.firstWindow()
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="capabilities"]').click()
    await expect(page.getByRole('checkbox', { name: 'Profile', exact: true })).not.toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Limit subagent capabilities', exact: true })).toBeChecked()
    await page.getByRole('button', { name: 'Enable all', exact: true }).click()
    await expect(page.getByRole('checkbox', { name: 'Profile', exact: true })).toBeChecked()
    await expect(page.getByRole('checkbox', { name: 'Limit subagent capabilities', exact: true })).not.toBeChecked()
    // Hold one IPC response to exercise leaving and remounting the page mid-save.
    const snapshot = await page.evaluate(() => globalThis.gale.config.get())
    await application.evaluate(({ ipcMain }, snapshot) => {
      ipcMain.removeHandler('config:saveDefaultCapabilities')
      ipcMain.handle('config:saveDefaultCapabilities', async (_event, value) => {
        await new Promise(resolve => { globalThis.__finishCapabilitySave = resolve })
        return { ...snapshot, defaultCapabilities: value }
      })
    }, snapshot)
    await page.getByRole('checkbox', { name: 'Profile', exact: true }).uncheck()
    await expect(page.getByRole('checkbox', { name: 'Profile', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="capabilities"]').click()
    const pendingProfile = page.getByRole('checkbox', { name: 'Profile', exact: true })
    await expect(pendingProfile).not.toBeChecked()
    await expect(pendingProfile).toBeDisabled()
    await application.evaluate(() => { globalThis.__finishCapabilitySave(); delete globalThis.__finishCapabilitySave })
    await expect(pendingProfile).toBeEnabled()
    await expect(pendingProfile).not.toBeChecked()
    await page.evaluate(() => globalThis.gale.config.updateSettings({ fontSize: 18, sidebarWidth: 420 }))
    await page.reload()
    await page.locator('.sidebar-settings').click()
    await page.locator('.app-menu-item').first().click()
    await page.locator('[data-settings-tab="capabilities"]').click()
    for (const width of [900, 1180]) {
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 780), width)
      await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(width)
      const controls = await Promise.all([
        page.getByRole('button', { name: 'Enable all', exact: true }).boundingBox(),
        page.getByRole('button', { name: 'Disable all', exact: true }).boundingBox(),
        page.getByRole('checkbox', { name: 'Limit subagent capabilities', exact: true }).locator('..').boundingBox()
      ])
      for (const [index, bounds] of controls.entries()) {
        assert.ok(bounds && bounds.width > 0 && bounds.x >= 0 && bounds.x + bounds.width <= width, 'Capability toolbar controls must fit the window.')
        for (const other of controls.slice(index + 1)) {
          assert.ok(other && (bounds.x + bounds.width <= other.x || other.x + other.width <= bounds.x
            || bounds.y + bounds.height <= other.y || other.y + other.height <= bounds.y),
          `Capability toolbar controls must not overlap at width ${width}: ${JSON.stringify(controls)}`)
        }
      }
      if (width === 900 && process.env.ANAS_E2E_CAPABILITIES_NARROW_SCREENSHOT) {
        await page.screenshot({ path: process.env.ANAS_E2E_CAPABILITIES_NARROW_SCREENSHOT })
      }
    }
    console.log('Default capabilities E2E passed: UI save, restart persistence, project overrides, prompt previews, unchanged subagents, atomic Enable all, pending saves across navigation and non-overlapping toolbar controls with large text.')
  } finally {
    await application?.close()
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyDefaultCapabilities }
