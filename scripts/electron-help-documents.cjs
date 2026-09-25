const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

async function verifyHelpDocuments(launchApplication) {
  const directory = await mkdtemp(join(tmpdir(), 'anas-help-documents-'))
  let application
  try {
    application = await launchApplication(directory)
    const page = await application.firstWindow({ timeout: 45_000 })
    await page.locator('[data-agent-composer-input]').waitFor()
    // Exercise both the narrow-window drawer and a narrow panel in a wide window.
    for (const [fontSize, width, theme] of [[14, 900, 'dark'], [20, 1440, 'light']]) {
      await page.evaluate((settings) => globalThis.gale.config.updateSettings(settings), { language: 'en', fontSize, theme })
      await application.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 760), width)
      await page.reload()
      await page.locator('[data-agent-composer-input]').waitFor()
      await page.locator('.sidebar-settings').click()
      await page.getByRole('menuitem', { name: 'Help', exact: true }).click()
      const toggle = page.getByRole('button', { name: 'Contents', exact: true })
      await expect(toggle).toBeEnabled()
      await toggle.click()
      const contents = page.getByRole('navigation', { name: 'Contents', exact: true })
      const document = page.locator('.ui-document-panel')
      const readingPosition = await document.evaluate((element) => element.scrollTop)
      await expect.poll(() => contents.evaluate((element) => element.scrollHeight > element.clientHeight), {
        message: 'The popup must constrain the contents itself, so long outlines can scroll.'
      }).toBe(true)
      await contents.hover({ position: { x: 40, y: 40 } })
      await page.mouse.wheel(0, 10000)
      await expect.poll(() => contents.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
      await expect.poll(() => contents.evaluate((element) => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(2)
      await expect(contents.getByRole('link').last()).toBeInViewport({ ratio: 1 })
      expect(await document.evaluate((element) => element.scrollTop)).toBe(readingPosition)
      const saved = await contents.evaluate((element) => element.scrollTop)
      await page.keyboard.press('Escape')
      await toggle.click()
      await expect.poll(() => contents.evaluate((element) => element.scrollTop)).toBe(saved)
      const target = await contents.getByRole('link').last().getAttribute('href')
      await contents.getByRole('link').last().click()
      await expect(contents).toHaveCount(0)
      await expect(page.locator(`[id="document-${decodeURIComponent(target.slice(1))}"]`)).toBeInViewport()
    }
    console.log('Help documents passed: popup wheel scrolling to the last chapter, independent reading position, reopening and navigation at default/large font sizes.')
  } finally {
    await application?.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}

module.exports = { verifyHelpDocuments }
