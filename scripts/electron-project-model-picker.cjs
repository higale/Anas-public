const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

async function expectInsideWindow(menu) {
  await expect.poll(() => menu.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const viewport = element.ownerDocument.defaultView
    return bounds.width > 0 && bounds.height > 0
      && bounds.top >= 0 && bounds.left >= 0
      && bounds.bottom <= viewport.innerHeight && bounds.right <= viewport.innerWidth
  }), { message: 'The complete menu must remain inside the application window' }).toBe(true)
}

async function verifyProjectModelPicker(launchApplication) {
  const home = await mkdtemp(join(tmpdir(), 'anas-project-model-picker-'))
  let application
  try {
    application = await launchApplication(home)
    const page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await page.locator('[data-agent-composer-input]').waitFor()
    await page.evaluate(async () => {
      const api = globalThis.gale.config
      await api.updateSettings({ language: 'en' })
      const config = await api.saveModelProvider({ name: 'Scroll test', protocol: 'openai_chat_completions',
        baseUrl: 'https://model-test.invalid/v1', apiKey: '', parameters: {}, modelListAuth: 'bearer' })
      const providerId = config.providers.find((provider) => provider.name === 'Scroll test').id
      for (let index = 0; index < 40; index++) {
        await api.saveProviderModel({ providerId, displayName: `Model ${index}`, model: `model-${index}`, parameters: {},
          parameterPresetMode: 'custom', parameterPresets: Array.from({ length: 40 }, (_, i) => ({ id: `preset-${i}`, name: `Preset ${i}`, parameters: { temperature: 1 } })),
          capabilities: { vision: true, toolUse: true }, stream: true, maxContextTokens: 128000, maxOutputTokens: 16000,
          contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
      }
    })
    await page.reload()
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 620))
    await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    const dialog = page.locator('.project-dialog')
    await dialog.getByRole('button', { name: 'Select model', exact: true }).click()
    const list = page.locator('.composer-model-options')
    await expect(list).toBeVisible()
    const menu = page.locator('.composer-model-menu')
    await expectInsideWindow(menu)
    const body = dialog.locator('.ui-dialog-body')
    const bodyScroll = await body.evaluate((element) => element.scrollTop)
    await expect.poll(() => list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await list.hover()
    const before = await list.evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, 600)
    await expect.poll(() => list.evaluate((element) => element.scrollTop), { message: 'Mouse wheel must scroll models inside the project dialog' }).toBeGreaterThan(before)
    await expect(body).toHaveJSProperty('scrollTop', bodyScroll)
    const scrolled = await list.evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, -300)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeLessThan(scrolled)
    if (process.env.ANAS_E2E_MODEL_PICKER_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_MODEL_PICKER_SCREENSHOT })
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Select model', exact: true })).toBeFocused()
    await dialog.getByRole('button', { name: 'Select model', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^Model 0(?: |$)/ }).click()
    await dialog.getByRole('button', { name: 'Reasoning options', exact: true }).click()
    const presets = page.locator('.composer-model-parameter-preset-menu')
    await expect(presets).toBeVisible()
    await expectInsideWindow(presets)
    await presets.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => presets.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    // The shared picker must still scroll outside a modal dialog.
    await page.getByRole('button', { name: 'Select model', exact: true }).click()
    await expectInsideWindow(menu)
    await list.hover()
    const composerBefore = await list.evaluate((element) => element.scrollTop)
    await page.mouse.wheel(0, 500)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(composerBefore)
    await page.keyboard.press('Escape')
    // Font changes and viewport resizing must use the current anchor space.
    await page.evaluate(() => globalThis.gale.config.updateSettings({ fontSize: 18 }))
    await page.reload()
    await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
    await page.locator('.project-details-action').filter({ hasText: 'Edit' }).click()
    await dialog.getByRole('button', { name: 'Select model', exact: true }).click()
    await expectInsideWindow(menu)
    await page.getByRole('menuitem', { name: 'Scroll test', exact: true }).click()
    await expectInsideWindow(menu)
    await page.getByRole('menuitem', { name: 'Scroll test', exact: true }).click()
    await expectInsideWindow(menu)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1180, 780))
    await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(1180)
    await expectInsideWindow(menu)
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 620))
    await expect.poll(() => page.evaluate(() => globalThis.innerWidth)).toBe(900)
    await expectInsideWindow(menu)
    await list.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    if (process.env.ANAS_E2E_MODEL_PICKER_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_MODEL_PICKER_SCREENSHOT })
    await page.mouse.wheel(0, 5000)
    await page.getByRole('menuitemradio', { name: /^Model 39(?: |$)/ }).click()
    await expect(dialog.getByRole('button', { name: 'Select model', exact: true })).toHaveText('Model 39')
    await dialog.getByRole('button', { name: 'Reasoning options', exact: true }).click()
    await expectInsideWindow(presets)
    await presets.hover()
    await page.mouse.wheel(0, 600)
    await expect.poll(() => presets.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    console.log('Project and composer model menus passed: viewport containment, small windows, large fonts, provider expansion, resizing, wheel scrolling, preset scrolling and focus restoration.')
  } finally {
    if (application) await application.close()
    await rm(home, { recursive: true, force: true })
  }
}
module.exports = { verifyProjectModelPicker }
