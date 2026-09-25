const { expect } = require('playwright/test')

async function verifyProjectPreviews(application) {
  const page = await application.firstWindow()
  await page.reload()
  await page.locator('.project-thread-group[data-default-workspace] .project-thread-more').click()
  await page.locator('.project-details-action').filter({ hasText: /Edit|编辑/ }).click()
  const project = page.locator('.project-dialog')
  const before = await page.evaluate(() => globalThis.gale.projects.list())
  await expect(project.locator('.project-prompt-preview-actions button')).toHaveCount(3)
  await project.getByRole('checkbox', { name: /^(定制能力|Customize capabilities)$/ }).check()
  const marker = 'PROJECT_PREVIEW_UNSAVED_INSTRUCTIONS'
  await project.locator('textarea').fill(marker)
  for (const [name, content] of [
    [/^(完整提示词|Full prompt)$/, marker],
    [/^(压缩提示词|Compression prompt)$/, undefined],
    [/^(预览请求|Preview request)$/, marker],
    [/^(压缩提示词|Compression prompt)$/, undefined]
  ]) {
    await project.getByRole('button', { name }).click()
    const preview = page.locator('.settings-code-preview-dialog')
    await expect(preview.locator('pre')).not.toBeEmpty({ timeout: 30_000 })
    if (content) await expect(preview.locator('pre')).toContainText(content)
    // No delay: Escape during a freshly opened nested layer must preserve its owner.
    await page.keyboard.press('Escape')
    await expect(preview).toHaveCount(0)
    await expect(project).toBeVisible()
    await expect(project.locator('textarea')).toHaveValue(marker)
  }
  if (process.env.ANAS_E2E_PROJECT_PREVIEW_SCREENSHOT) {
    await project.screenshot({ path: process.env.ANAS_E2E_PROJECT_PREVIEW_SCREENSHOT })
  }
  await project.getByRole('button', { name: /^(取消|Cancel)$/ }).click()
  await expect.poll(() => page.evaluate(() => globalThis.gale.projects.list())).toEqual(before)
}

module.exports = { verifyProjectPreviews }
