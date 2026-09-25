const assert = require('node:assert/strict')
const { mkdir, mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { expect } = require('playwright/test')

async function verifyGlobalSettings(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-global-settings-'))
  let application
  try {
    const extraFolder = join(root, 'extra')
    await mkdir(extraFolder)
    application = await launchApplication(root)
    const page = await application.firstWindow()
    await page.waitForSelector('[data-agent-composer-input]')
    const projectNames = await page.evaluate(async (root) => {
      await globalThis.gale.config.updateSettings({ language: 'en' })
      const project = (await globalThis.gale.projects.list()).find((item) => item.id === 'default-workspace')
      const capabilities = {
        ...project.capabilities, profile: false, subagents: false, memory: false,
        skills: { ...project.capabilities.skills, enabled: false }, mcp: { defaultMode: 'selected', servers: [] }
      }
      const first = await globalThis.gale.projects.update(project.id, { ...project, advancedSettings: true, capabilities })
      const second = await globalThis.gale.projects.create({ ...project, name: 'Other workspace', sourceFolders: [root] })
      if (first.status !== 'ok' || second.status !== 'ok') throw new Error('Project fixture setup failed.')
      return [first.value.name, second.value.name]
    }, root)
    await application.evaluate(({ ipcMain }, extraFolder) => {
      globalThis.__globalSettingsReloads = 0
      ipcMain.removeHandler('mcp:reloadFailed')
      ipcMain.handle('mcp:reloadFailed', () => {
        globalThis.__globalSettingsReloads += 1
        return { scheduled: false, reason: 'no_servers' }
      })
      ipcMain.removeHandler('skills:get')
      ipcMain.handle('skills:get', (_event, projectId, sourceFolders) => {
        const roots = ['system', 'user', ...(projectId ? ['project'] : []), ...(sourceFolders?.length > 1 ? ['project-extra'] : [])].map((id) => ({
          id, kind: id.startsWith('project') ? 'project' : id, name: `${id} directory`, shortcutAlias: id,
          path: `/skills/${id}`, removable: false, available: true
        }))
        return { projectId, roots, scriptAutoApprove: false, skills: roots.map((source) => ({
          id: `${source.id}:search`, rootId: source.id, name: `${source.id}-search`, description: 'Search skill',
          modelAvailable: true, userAvailable: true, scriptAutoApprove: false, linked: false, dirPath: `${source.path}/search`,
          relativePath: 'search', source: source.kind, rootName: source.name, shortcutAlias: source.shortcutAlias,
          shortcut: `/${source.id}-search`
        })) }
      })
      ipcMain.removeHandler('projects:chooseSourceFolders')
      ipcMain.handle('projects:chooseSourceFolders', () => ({ status: 'ok', value: [extraFolder] }))
    }, extraFolder)
    await page.reload()
    for (const name of projectNames) {
      await page.locator('.project-thread-group').filter({ has: page.locator('.project-thread-label', { hasText: name }) })
        .locator('.project-thread-new-chat').click()
      if (name === 'Other workspace') {
        await page.locator('[data-agent-composer-input]').fill('/project')
        await expect(page.locator('.composer-suggestion-apply').filter({ hasText: 'project-search' })).toBeVisible()
        await page.locator('[data-agent-composer-input]').fill('')
        await page.locator('.project-thread-group').filter({ hasText: name }).locator('.project-thread-more').click()
        await page.locator('.project-details-action').filter({ hasText: /Edit/ }).click()
        const dialog = page.locator('.project-dialog')
        await dialog.getByRole('button', { name: 'Add folders', exact: true }).click()
        await expect(dialog.locator('.project-folder-item')).toHaveCount(2)
        await dialog.locator('button[type="submit"]').click()
        await expect(dialog).not.toBeVisible()
        await page.locator('[data-agent-composer-input]').fill('/project-extra')
        await expect(page.locator('.composer-suggestion-apply').filter({ hasText: 'project-extra-search' })).toBeVisible()
        await page.locator('[data-agent-composer-input]').fill('')
      }
      await page.locator('.sidebar-settings').click()
      await page.locator('.app-menu-item').first().click()
      await page.locator('[data-settings-tab="general"]').click()
      await expect(page.getByRole('heading', { name: 'General', exact: true })).toBeVisible()
      await expect(page.locator('[data-settings-tab="appearance"], [data-settings-tab="localData"]')).toHaveCount(0)
      for (const heading of ['Assistant profile', 'User profile', 'Appearance', 'Data management']) {
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
      }
      const assistantName = `Assistant for ${name}`
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill(assistantName)
      await page.getByRole('textbox', { name: 'Name', exact: true }).blur()
      await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.profile.assistant.name)).toBe(assistantName)
      await page.getByRole('combobox', { name: 'Theme', exact: true }).click()
      await page.getByRole('option', { name: 'Dark', exact: true }).click()
      await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.theme)).toBe('dark')
      if (process.env.ANAS_E2E_GENERAL_SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_GENERAL_SETTINGS_SCREENSHOT })
      await page.getByRole('button', { name: 'Clean up...', exact: true }).click()
      const cleanup = page.getByRole('alertdialog')
      await expect(cleanup).toBeVisible()
      await cleanup.getByRole('button', { name: 'Cancel', exact: true }).click()
      for (const tab of ['general', 'subagents', 'skills', 'memory', 'mcp']) {
        await page.locator(`[data-settings-tab="${tab}"]`).click()
        await expect(page.locator('.settings-page-header [role="img"]')).toHaveCount(0)
      }
      const reload = page.getByRole('button', { name: 'Restart failed MCP servers', exact: true })
      await expect(reload).toBeEnabled()
      await reload.click()
      await page.locator('[data-settings-tab="skills"]').click()
      await page.getByRole('button', { name: /^All Skills/ }).click()
      await expect(page.locator('.settings-skill-tree-select')).toHaveCount(2)
      await expect(page.locator('.settings-skill-tree')).not.toContainText('project-search')
      await expect(page.locator('.settings-skill-tree')).not.toContainText('Project')
      await page.locator('[data-settings-tab="memory"]').click()
      await page.getByRole('button', { name: 'New memory', exact: true }).click()
      const editor = page.locator('.settings-memory-editor')
      await expect(editor.getByRole('combobox', { name: 'Scope', exact: true })).toHaveValue('Global')
      await editor.locator('textarea').fill(`Memory from ${name}`)
      await editor.getByRole('button', { name: 'Save', exact: true }).click()
      await expect.poll(() => page.evaluate(async (name) => (await globalThis.gale.memory.search()).items
        .some((item) => item.content === `Memory from ${name}` && item.scope === 'global' && !item.projectId), name)).toBe(true)
      if (process.env.ANAS_E2E_GLOBAL_SETTINGS_SCREENSHOT) await page.screenshot({ path: process.env.ANAS_E2E_GLOBAL_SETTINGS_SCREENSHOT })
      await page.getByRole('button', { name: 'Back to app', exact: true }).click()
    }
    assert.equal(await application.evaluate(() => globalThis.__globalSettingsReloads), 2)
    const memories = await page.evaluate(() => globalThis.gale.memory.search())
    assert.equal(memories.total, 2)
    console.log('Global settings E2E passed: unified General page with profile/theme saves and cleanup access, project-independent pages, global skills and memories, MCP without a model, and project composer skills including edited source folders.')
  } finally {
    await application?.close()
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyGlobalSettings }
