import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { requiresToolApproval } from '../agent/toolAuthorization'
import { withToolExecution } from '../agent/toolExecutionContext'
import { runWithCurrentAgentToolEffect, type AgentToolEffectArm } from '../agent/toolEffectScope'
import { createHttpRequestTool, executeHttpRequest } from './httpRequestTool'

const registry = vi.hoisted(() => ({ path: '' }))
vi.mock('../config/dataDir', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/dataDir')>(),
  getTempDir: () => registry.path
}))
beforeAll(async () => { registry.path = await mkdtemp(join(tmpdir(), 'anas-http-registry-')) })
afterAll(async () => { await rm(registry.path, { recursive: true, force: true }) })

async function requestBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

describe('http_request', () => {
  let root: string
  let origin: string
  let closeServer: () => Promise<void>

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'anas-http-request-')))
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      if (request.url === '/large') {
        response.setHeader('content-type', 'text/plain')
        response.end('abcdefgh')
        return
      }
      if (request.url === '/upload') {
        const body = await requestBytes(request)
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          method: request.method,
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body: body.toString('utf8')
        }))
        return
      }
      if (request.url === '/binary') {
        response.setHeader('content-type', 'application/octet-stream')
        response.end(Buffer.from([0, 1, 2, 3, 255]))
        return
      }
      if (request.url === '/redirect') {
        response.statusCode = 302
        response.setHeader('location', '/binary')
        response.end()
        return
      }
      if (request.url === '/slow-download') {
        response.write('partial')
        setTimeout(() => response.end(' response'), 200)
        return
      }
      if (request.url === '/timeout') {
        response.write('partial')
        setTimeout(() => response.end(' response'), 1_200)
        return
      }
      if (request.url === '/disconnect') {
        request.socket.destroy()
        return
      }
      if (request.url === '/missing') {
        response.statusCode = 404
        response.end('not found')
        return
      }
      response.statusCode = 500
      response.end('unexpected route')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not expose a TCP port')
    origin = `http://127.0.0.1:${address.port}`
    closeServer = () => new Promise<void>((resolve, reject) => {
      server.close((reason) => reason ? reject(reason) : resolve())
    })
  })

  afterEach(async () => {
    await closeServer()
    await rm(root, { recursive: true, force: true })
  })

  it('streams and bounds text responses without buffering the complete body', async () => {
    const output = await executeHttpRequest({
      url: `${origin}/large`,
      max_bytes: 4,
      include_metadata: true
    }, { primaryFolder: root })

    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      status: 200,
      body: 'abcd',
      truncated: true
    })
  })

  it('reports download byte progress and a structured outcome', async () => {
    const progress: Array<{ current: number; total?: number }> = []
    const outcomes: Array<Record<string, unknown>> = []
    const output = await executeHttpRequest({
      url: `${origin}/binary`,
      output_path: 'progress.bin'
    }, {
      primaryFolder: root,
      onProgress: (current, total) => progress.push({
        current,
        ...(total === undefined ? {} : { total })
      }),
      onResult: (outcome) => outcomes.push(outcome)
    })

    expect(JSON.parse(output)).toMatchObject({ ok: true, bytes: 5 })
    expect(progress.at(-1)).toEqual({ current: 5, total: 5 })
    expect(outcomes).toEqual([expect.objectContaining({
      ok: true,
      status: 200,
      bytes: 5,
      path: join(root, 'progress.bin')
    })])
  })

  it('does not impose an execution timeout when timeout is omitted', async () => {
    const progress: Array<{ current: number; total?: number }> = []
    const output = await executeHttpRequest({
      url: `${origin}/timeout`,
      output_path: 'unlimited-time.bin'
    }, {
      primaryFolder: root,
      onProgress: (current, total) => progress.push({
        current,
        ...(total === undefined ? {} : { total })
      })
    })

    expect(JSON.parse(output)).toMatchObject({ ok: true, bytes: 16 })
    expect(progress.at(-1)).toEqual({ current: 16 })
    expect(await readFile(join(root, 'unlimited-time.bin'), 'utf8')).toBe('partial response')
  })

  it('uploads from and downloads to the approved canonical targets after a directory link changes', async () => {
    const approvedRoot = await realpath(await mkdtemp(join(tmpdir(), 'anas-http-approved-')))
    const replacementRoot = await realpath(await mkdtemp(join(tmpdir(), 'anas-http-replacement-')))
    try {
      const link = join(root, 'linked')
      await writeFile(join(approvedRoot, 'upload.txt'), 'approved upload', 'utf8')
      await writeFile(join(replacementRoot, 'upload.txt'), 'replacement upload', 'utf8')
      await symlink(approvedRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
      const args: Record<string, unknown> = {
        url: `${origin}/upload`,
        method: 'POST',
        body_file: join(link, 'upload.txt'),
        output_path: join(link, 'result.json')
      }
      await expect(requiresToolApproval({
        toolName: 'http_request',
        args,
        primaryFolder: root,
        trustedFolders: [root],
        accessMode: 'strict_approval'
      })).resolves.toBe(true)
      expect(args.body_file).toBe(join(approvedRoot, 'upload.txt'))
      expect(args.output_path).toBe(join(approvedRoot, 'result.json'))

      await rm(link, { recursive: true })
      await symlink(replacementRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
      const result = JSON.parse(await executeHttpRequest(args, { primaryFolder: root })) as Record<string, unknown>
      expect(result).toMatchObject({ ok: true, path: join(approvedRoot, 'result.json') })
      expect(await readFile(join(approvedRoot, 'result.json'), 'utf8')).toContain('approved upload')
      await expect(readFile(join(replacementRoot, 'result.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await Promise.all([
        rm(approvedRoot, { recursive: true, force: true }),
        rm(replacementRoot, { recursive: true, force: true })
      ])
    }
  })

  it('arms only mutating requests and downloads at the real request boundary', async () => {
    const effects: AgentToolEffectArm[] = []
    const invoke = (input: Record<string, unknown>) => runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => executeHttpRequest(input, { primaryFolder: root }))

    await invoke({ url: `${origin}/large` })
    expect(effects).toEqual([])

    process.env.ANAS_HTTP_EFFECT_RESOURCE = 'item-A'
    process.env.ANAS_HTTP_EFFECT_TOKEN = 'tenant-A'
    process.env.ANAS_HTTP_IDEMPOTENCY_SECRET = 'idempotency-secret-canary'
    try {
      await invoke({
        url: `${origin}/upload?resource=\${ANAS_HTTP_EFFECT_RESOURCE}`,
        method: 'POST',
        headers: {
          Authorization: 'Bearer ${ANAS_HTTP_EFFECT_TOKEN}',
          'Idempotency-Key': '${ANAS_HTTP_IDEMPOTENCY_SECRET}'
        },
        body: 'payload'
      })
      process.env.ANAS_HTTP_EFFECT_RESOURCE = 'item-B'
      await invoke({
        url: `${origin}/upload?resource=\${ANAS_HTTP_EFFECT_RESOURCE}`,
        method: 'POST',
        headers: {
          Authorization: 'Bearer ${ANAS_HTTP_EFFECT_TOKEN}',
          'Idempotency-Key': '${ANAS_HTTP_IDEMPOTENCY_SECRET}'
        },
        body: 'payload'
      })
      process.env.ANAS_HTTP_EFFECT_TOKEN = 'tenant-B'
      await invoke({
        url: `${origin}/upload?resource=\${ANAS_HTTP_EFFECT_RESOURCE}`,
        method: 'POST',
        headers: {
          Authorization: 'Bearer ${ANAS_HTTP_EFFECT_TOKEN}',
          'Idempotency-Key': '${ANAS_HTTP_IDEMPOTENCY_SECRET}'
        },
        body: 'payload'
      })
    } finally {
      delete process.env.ANAS_HTTP_EFFECT_RESOURCE
      delete process.env.ANAS_HTTP_EFFECT_TOKEN
      delete process.env.ANAS_HTTP_IDEMPOTENCY_SECRET
    }
    expect(effects).toEqual([
      expect.objectContaining({
        kind: 'http_request',
        recoveryMode: 'idempotent',
        idempotencyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        target: expect.objectContaining({
          requestedUrl: `${origin}/upload?resource=\${ANAS_HTTP_EFFECT_RESOURCE}`,
          resolvedUrlFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          headersFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          bodyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      }),
      expect.objectContaining({
        kind: 'http_request',
        target: expect.objectContaining({
          requestedUrl: `${origin}/upload?resource=\${ANAS_HTTP_EFFECT_RESOURCE}`
        })
      }),
      expect.objectContaining({
        kind: 'http_request',
        target: expect.objectContaining({
          requestedUrl: `${origin}/upload?resource=\${ANAS_HTTP_EFFECT_RESOURCE}`
        })
      })
    ])
    const headerFingerprints = effects.map((effect) => (
      effect.target as { headersFingerprint: string }
    ).headersFingerprint)
    expect(headerFingerprints[0]).toBe(headerFingerprints[1])
    expect(headerFingerprints[1]).not.toBe(headerFingerprints[2])
    const urlFingerprints = effects.map((effect) => (
      effect.target as { resolvedUrlFingerprint: string }
    ).resolvedUrlFingerprint)
    expect(urlFingerprints[0]).not.toBe(urlFingerprints[1])
    expect(urlFingerprints[1]).toBe(urlFingerprints[2])
    expect(JSON.stringify(effects)).not.toContain('item-A')
    expect(JSON.stringify(effects)).not.toContain('item-B')
    expect(JSON.stringify(effects)).not.toContain('tenant-A')
    expect(JSON.stringify(effects)).not.toContain('tenant-B')
    expect(JSON.stringify(effects)).not.toContain('idempotency-secret-canary')

    effects.length = 0
    await invoke({
      url: `${origin}/binary`,
      output_path: 'downloads/effect.bin'
    })
    expect(effects).toEqual([expect.objectContaining({
      kind: 'http_request_with_download',
      recoveryMode: 'confirm'
    })])
  })

  it('uploads a workspace-relative raw file and resolves environment placeholders', async () => {
    await writeFile(join(root, 'payload.txt'), 'file payload')
    const effects: AgentToolEffectArm[] = []
    const invoke = () => runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => executeHttpRequest({
      url: `${origin}/upload`,
      headers: { Authorization: 'Bearer ${ANAS_HTTP_TEST_TOKEN}' },
      body_file: 'payload.txt'
    }, { primaryFolder: root }))
    process.env.ANAS_HTTP_TEST_TOKEN = 'secret-token'
    try {
      const output = await invoke()
      expect(JSON.parse(output)).toMatchObject({
        method: 'POST',
        authorization: 'Bearer secret-token',
        contentType: 'application/octet-stream',
        body: 'file payload'
      })
      await writeFile(join(root, 'payload.txt'), 'changed payload')
      await invoke()
    } finally {
      delete process.env.ANAS_HTTP_TEST_TOKEN
    }
    const bodyFingerprints = effects.map((effect) => (
      effect.target as { bodyFingerprint: string }
    ).bodyFingerprint)
    expect(bodyFingerprints).toHaveLength(2)
    expect(bodyFingerprints[0]).not.toBe(bodyFingerprints[1])
  })

  it('builds multipart forms with text fields and workspace-relative files', async () => {
    await writeFile(join(root, 'photo.txt'), 'image bytes')
    const output = await executeHttpRequest({
      url: `${origin}/upload`,
      form_fields: { prompt: 'pineapple' },
      form_files: [{ field: 'image', path: 'photo.txt', filename: 'sample.txt' }]
    }, { primaryFolder: root })
    const received = JSON.parse(output)

    expect(received.method).toBe('POST')
    expect(received.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(received.body).toContain('name="prompt"')
    expect(received.body).toContain('pineapple')
    expect(received.body).toContain('filename="sample.txt"')
    expect(received.body).toContain('image bytes')
  })

  it('downloads successful binary responses atomically to a relative path', async () => {
    const output = await executeHttpRequest({
      url: `${origin}/binary`,
      output_path: 'downloads/result.bin'
    }, { primaryFolder: root })
    const metadata = JSON.parse(output)

    expect(metadata).toMatchObject({ ok: true, status: 200, bytes: 5 })
    expect(metadata.path).toBe(join(root, 'downloads', 'result.bin'))
    expect(await readFile(metadata.path)).toEqual(Buffer.from([0, 1, 2, 3, 255]))
    expect(await readdir(join(root, 'downloads'))).toEqual(['result.bin'])
  })

  it('follows redirects and replaces an existing target only after success', async () => {
    const target = join(root, 'existing.bin')
    await writeFile(target, 'old content')
    const output = await executeHttpRequest({
      url: `${origin}/redirect`,
      output_path: 'existing.bin',
      overwrite: true
    }, { primaryFolder: root })

    expect(JSON.parse(output)).toMatchObject({ ok: true, status: 200, bytes: 5 })
    expect(await readFile(target)).toEqual(Buffer.from([0, 1, 2, 3, 255]))
    expect(await readdir(root)).toEqual(['existing.bin'])
  })

  it('can return a redirect response without following it', async () => {
    const output = await executeHttpRequest({
      url: `${origin}/redirect`,
      follow_redirects: false,
      include_metadata: true
    }, { primaryFolder: root })

    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      status: 302,
      url: `${origin}/redirect`
    })
  })

  it('does not replace the target with an HTTP error response', async () => {
    const target = join(root, 'existing.txt')
    await writeFile(target, 'keep me')
    const output = await executeHttpRequest({
      url: `${origin}/missing`,
      output_path: 'existing.txt',
      overwrite: true
    }, { primaryFolder: root })

    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      status: 404,
      body: 'not found'
    })
    expect(await readFile(target, 'utf8')).toBe('keep me')
    expect(await readdir(root)).toEqual(['existing.txt'])
  })

  it('removes temporary files when a download exceeds its byte limit', async () => {
    const output = await executeHttpRequest({
      url: `${origin}/large`,
      output_path: 'limited.txt',
      max_bytes: 4
    }, { primaryFolder: root })

    expect(JSON.parse(output)).toMatchObject({ ok: false })
    expect(await readdir(root)).toEqual([])
  })

  it('cancels an in-progress download and removes its temporary file', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 25)
    const output = await executeHttpRequest({
      url: `${origin}/slow-download`,
      output_path: 'cancelled.txt'
    }, { primaryFolder: root, signal: controller.signal })

    expect(JSON.parse(output)).toEqual({ ok: false, error: 'request cancelled' })
    expect(await readdir(root)).toEqual([])
  })

  it('does not start a request when its external signal is already cancelled', async () => {
    const controller = new AbortController()
    const effects: AgentToolEffectArm[] = []
    controller.abort()
    const output = await runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => executeHttpRequest({
      url: `${origin}/upload`,
      method: 'POST',
      body: 'payload'
    }, {
      primaryFolder: root,
      signal: controller.signal
    }))

    expect(JSON.parse(output)).toEqual({ ok: false, error: 'request cancelled' })
    expect(effects).toEqual([])
  })

  it.each([
    {
      name: 'a non-idempotent request',
      input: { method: 'POST', body: 'payload' }
    },
    {
      name: 'a download request',
      input: { output_path: 'disconnected.bin' }
    }
  ])('propagates an uncertain dispatched outcome to the call layer for $name', async ({ input }) => {
    let running = false
    let uncertainReason: string | undefined
    const httpRequest = createHttpRequestTool({ primaryFolder: root })
    const output = await withToolExecution({
      signal: new AbortController().signal,
      markRunning: () => { running = true },
      markLocalCommit: () => undefined,
      markUncertain: (reason) => { uncertainReason = reason },
      output: () => undefined,
      progress: () => undefined,
      setOutcome: () => undefined
    }, false, () => httpRequest.invoke({
      summary: 'Exercise an interrupted request',
      url: origin + '/disconnect',
      ...input
    }))
    expect(JSON.parse(String(output))).toMatchObject({ ok: false })
    expect(running).toBe(true)
    expect(uncertainReason).toContain('outcome is unknown')
  })

  it('times out an in-progress download and removes its temporary file', async () => {
    const output = await executeHttpRequest({
      url: `${origin}/timeout`,
      output_path: 'timed-out.txt',
      timeout: 1
    }, { primaryFolder: root })

    expect(JSON.parse(output)).toEqual({ ok: false, error: 'request timed out after 1 seconds' })
    expect(await readdir(root)).toEqual([])
  })
})
