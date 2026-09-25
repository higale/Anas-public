const assert = require('node:assert/strict')
const { expect } = require('playwright/test')

// Inspect the same locally bundled Monaco instance as the renderer.
async function monacoState(application, page) {
  const url = await application.evaluate(({ BrowserWindow }) => {
    const { dirname, join } = process.getBuiltinModule('node:path')
    const { fileURLToPath, pathToFileURL } = process.getBuiltinModule('node:url')
    const directory = join(dirname(fileURLToPath(BrowserWindow.getAllWindows()[0].webContents.getURL())), 'assets')
    const name = process.getBuiltinModule('node:fs').readdirSync(directory).find((entry) => /^monacoRuntime-.*\.js$/.test(entry))
    if (!name) throw new Error('Bundled Monaco entry is missing.')
    return pathToFileURL(join(directory, name)).href
  })
  return page.evaluate(async (url) => {
    const module = await import(url)
    const monaco = Object.values(module).find((value) => value?.monaco?.editor?.getModels)?.monaco
    if (!monaco) throw new Error('Monaco API is unavailable.')
    return {
      models: monaco.editor.getModels().map((model) => model.getValue()),
      modelUris: monaco.editor.getModels().map((model) => model.uri.toString()),
      wrapping: monaco.editor.getDiffEditors().map((diff) => ({
        original: diff.getOriginalEditor().getOption(monaco.editor.EditorOption.wrappingInfo).isViewportWrapping,
        modified: diff.getModifiedEditor().getOption(monaco.editor.EditorOption.wrappingInfo).isViewportWrapping
      })),
      editors: monaco.editor.getDiffEditors().map((diff) => ({
        originalReadonly: diff.getOriginalEditor().getOption(monaco.editor.EditorOption.readOnly),
        modifiedReadonly: diff.getModifiedEditor().getOption(monaco.editor.EditorOption.readOnly)
      }))
    }
  }, url)
}

async function verifyReadonlyDiff(application, page) {
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20000 })
  const initial = await monacoState(application, page)
  assert.equal(initial.models.length, 2)
  assert.deepEqual(initial.editors, [{ originalReadonly: true, modifiedReadonly: true }])
  const actions = page.locator('.ui-panel-toolbar')
  const sideBySide = actions.getByRole('button', { name: /^(左右对比|Side by side)$/ })
  const initiallySideBySide = await sideBySide.getAttribute('aria-pressed') === 'true'
  await sideBySide.focus()
  await page.keyboard.press('Enter')
  await expect(sideBySide).toHaveAttribute('aria-pressed', String(!initiallySideBySide))
  await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.diffViewMode))
    .toBe(initiallySideBySide ? 'inline' : 'side_by_side')
  await page.locator('.monaco-editor.modified-in-monaco-diff-editor .lines-content > .view-lines').click()
  await page.keyboard.type('Must not edit')
  assert.deepEqual((await monacoState(application, page)).models, initial.models)
  if (!initiallySideBySide) await sideBySide.click()
  await expect(sideBySide).toHaveAttribute('aria-pressed', 'false')
  const fold = actions.getByRole('button', { name: /^(折叠未修改区域|Fold unchanged regions)$/ })
  await expect(fold).toHaveAttribute('aria-pressed', 'true')
  await fold.click()
  await expect(fold).toHaveAttribute('aria-pressed', 'false')
  await fold.click()
  await expect.poll(() => page.evaluate(async () => (await globalThis.gale.config.get()).settings.diffViewMode)).toBe('inline')
  const workspace = page.locator('.agent-workspace')
  const panel = page.locator('.workspace-panels')
  const originalBounds = await panel.boundingBox(), workspaceBounds = await workspace.boundingBox()
  const files = panel.locator('.ui-diff-file-list'), contents = panel.locator('.ui-diff-content')
  const selectedFile = await files.locator('[aria-pressed="true"]').innerText()
  assert.ok((await files.boundingBox()).y < (await contents.boundingBox()).y, 'Narrow file lists must appear above the diff.')

  assert.ok(Math.abs(originalBounds.y - workspaceBounds.y) <= 1, 'Right workspace must reach the title bar.')
  const composer = page.locator('[data-agent-composer-input]')
  const draft = await composer.inputValue()
  await composer.fill('Unsent draft survives expanded viewing')
  await page.getByRole('button', { name: /^(展开右栏以占满对话区|Expand right workspace to fill conversation area)$/ }).click()
  await expect(composer).not.toBeVisible()
  const expandedBounds = await panel.boundingBox()
  const filesBounds = await files.boundingBox(), diffBounds = await contents.boundingBox()
  assert.ok(filesBounds.x >= diffBounds.x + diffBounds.width - 1, 'Wide file lists must appear beside the diff on its right.')
  assert.equal(await files.locator('[aria-pressed="true"]').innerText(), selectedFile)
  assert.deepEqual((await monacoState(application, page)).modelUris, initial.modelUris)

  assert.ok(Math.abs(expandedBounds.x - workspaceBounds.x) <= 1 && Math.abs(expandedBounds.width - workspaceBounds.width) <= 1,
    'Expanded right workspace must fill the conversation area.')
  assert.deepEqual((await monacoState(application, page)).models, initial.models)
  await page.getByRole('button', { name: /^(还原右栏宽度|Restore right workspace width)$/ }).click()
  await expect(composer).toHaveValue('Unsent draft survives expanded viewing')
  await expect(composer).toBeVisible()
  assert.equal(await files.locator('[aria-pressed="true"]').innerText(), selectedFile)
  assert.deepEqual((await monacoState(application, page)).modelUris, initial.modelUris)
  assert.ok(Math.abs((await panel.boundingBox()).width - originalBounds.width) <= 1, 'Restore must retain the previous panel width.')
  await composer.fill(draft)
  const topbar = page.locator('.topbar')
  for (let index = 0; index < 3; index++) {
    await panel.getByRole('button', { name: /^(收起右侧工作区|Hide right workspace)$/ }).click()
    assert.equal((await monacoState(application, page)).models.length, 0)
    await topbar.getByRole('button', { name: /^(展开右侧工作区|Show right workspace)$/ }).click()
    await expect(page.locator('.monaco-diff-editor')).toBeVisible()
    assert.equal((await monacoState(application, page)).models.length, 2)
  }
}
module.exports = { verifyReadonlyDiff, monacoState }
