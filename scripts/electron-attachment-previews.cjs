const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { basename, dirname, join } = require('node:path')
const { expect } = require('playwright/test')
const { closeElectronTestApplication } = require('./electron-test-close.cjs')
const settingsDefaults = require('../data/config/settings.json')

function bitmap(width, height) {
  const stride = Math.ceil(width * 3 / 4) * 4
  const bytes = Buffer.alloc(54 + stride * height, 180)
  bytes.fill(0, 0, 54)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14)
  bytes.writeInt32LE(width, 18)
  bytes.writeInt32LE(height, 22)
  bytes.writeUInt16LE(1, 26)
  bytes.writeUInt16LE(24, 28)
  bytes.writeUInt32LE(stride * height, 34)
  return bytes
}

async function verifyAttachmentPreviews(launchApplication) {
  const root = await mkdtemp(join(tmpdir(), 'anas-image-preview-e2e-'))
  if (dirname(root) !== tmpdir() || !basename(root).startsWith('anas-image-preview-e2e-')) throw new Error('Unexpected test directory.')
  const photo = join(root, '照片 #1 %.bmp')
  const large = join(root, '超大 # %.bmp')
  const profile = join(root, 'profile')
  let application
  let requests = 0
  const errors = []
  const server = createServer((request, response) => {
    void (async () => {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      const images = input.messages.flatMap(message => Array.isArray(message.content)
        ? message.content.filter(block => block.type === 'image_url') : [])
      assert.equal(images.length, 1)
      assert.ok(Buffer.from(images[0].image_url.url.split(',')[1], 'base64').length > 10 * 1024 * 1024)
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'photo-response', object: 'chat.completion', created: 1, model: input.model,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Photo received.' } }],
        usage: { prompt_tokens: 2000, completion_tokens: 5, total_tokens: 2005 } }))
    })().catch(error => { errors.push(String(error)); response.writeHead(400); response.end(String(error)) })
  })
  try {
    await writeFile(photo, bitmap(2048, 1707))
    await writeFile(large, bitmap(3072, 3000))
    await mkdir(join(profile, 'config'), { recursive: true })
    await writeFile(join(profile, 'config', 'settings.json'), JSON.stringify({ ...settingsDefaults, language: 'en' }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    application = await launchApplication(profile)
    const page = await application.firstWindow()
    page.setDefaultTimeout(15_000)
    await expect(page.locator('[data-agent-composer-input]')).toBeVisible()
    await page.evaluate(async port => {
      const api = globalThis.gale.config
      const config = await api.saveModelProvider({ name: 'Preview test', protocol: 'openai_chat_completions',
        baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', parameters: {}, modelListUrl: '', modelListAuth: 'bearer' })
      const providerId = config.providers.find(provider => provider.name === 'Preview test').id
      await api.saveProviderModel({ providerId, displayName: 'Photo model', model: 'photo', parameters: {},
        parameterPresetMode: 'none', capabilities: { vision: true, toolUse: false }, stream: false,
        maxContextTokens: 100000, maxOutputTokens: 1000, contextCompressionThreshold: 0.8, contextCompressionEnabled: true })
    }, server.address().port)
    await page.getByRole('button', { name: 'Select model', exact: true }).click()
    await page.getByRole('menuitemradio', { name: /^Photo model(?: |$)/ }).click()
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, photo)
    await page.getByRole('button', { name: /attach file/i }).click()
    await page.locator('.attachment-grid-composer .attachment-open').click()
    const slide = page.locator('.yarl__slide_current .yarl__slide_image')
    await expect.poll(() => slide.evaluate(image => image.naturalWidth)).toBe(2048)
    await page.keyboard.press('Escape')
    await page.locator('[data-agent-composer-input]').fill('Inspect the photo.')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByText('Photo received.', { exact: true })).toBeVisible()
    await page.locator('.attachment-grid-message .attachment-open').click()
    await expect(slide).toHaveAttribute('src', /^anas-image:/)
    await expect.poll(() => slide.evaluate(image => image.naturalWidth)).toBe(2048)
    await page.screenshot({ path: join(tmpdir(), 'anas-original-photo-preview.png') })
    await page.keyboard.press('Escape')

    const largeResult = await page.evaluate(async path => {
      const preview = await globalThis.gale.files.readAttachmentPreview(path, { mode: 'original' })
      const image = new globalThis.Image()
      image.src = preview.src
      await image.decode()
      const [selected] = await globalThis.gale.files.readAttachments([path])
      return { width: image.naturalWidth, height: image.naturalHeight, rejected: selected.skippedReason }
    }, large)
    assert.equal(largeResult.width, 3072)
    assert.equal(largeResult.height, 3000)
    assert.match(largeResult.rejected, /exceeds 25 MB/)
    assert.equal(requests, 1)
    assert.deepEqual(errors, [])
    console.log('Attachment previews Electron E2E passed: 10 MiB photo before/after send at original resolution; preview over 25 MiB; sending limit retained.')
  } finally {
    await closeElectronTestApplication(application)
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  }
}

module.exports = { verifyAttachmentPreviews }
