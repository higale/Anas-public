import { execFile, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BehaviorCase } from './codingTasks'

export interface BehaviorResult {
  runner: 'node:test'
  expected: number
  completed: number
  passed: number
  failed: number
  status: 'passed' | 'failed'
  error: string | null
  output: string
}

/** Tests live outside the candidate workspace and use Node's own test runner. */
export async function runBehaviorTests(root: string, cases: BehaviorCase[], signal?: AbortSignal): Promise<BehaviorResult> {
  const directory = await mkdtemp(join(tmpdir(), 'anas-behavior-'))
  const result: BehaviorResult = { runner: 'node:test', expected: cases.length, completed: 0, passed: 0, failed: 0,
    status: 'failed', error: null, output: '' }
  try {
    signal?.throwIfAborted()
    const file = join(directory, 'behavior.test.mjs')
    await writeFile(file, `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assert } from 'node:assert';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const cases = JSON.parse(${JSON.stringify(JSON.stringify(cases))});
const root = ${JSON.stringify(root)};
const resultAssert = new Assert({ skipPrototype: true });
for (const item of cases) test(item.id, async () => {
  const module = await import(pathToFileURL(resolve(root, item.module)).href);
  if (item.kind === 'exports') assert.deepEqual(Object.keys(module).sort(), [...item.expected].sort());
  else if (item.kind === 'value') assert.deepEqual(item.path.reduce((value, key) => value[key], module), item.expected);
  else {
    const args = structuredClone(item.args);
    resultAssert.deepStrictEqual(await module[item.export](...args), item.expected);
    assert.deepEqual(args, item.args, 'The function must preserve its input.');
  }
});
`)
    // Electron's embedded Node matches the runtime ABI. Disable test process
    // isolation so cancellation kills the sole runner, including blocking JS.
    let child!: ChildProcess
    const execution = new Promise<string>((resolve) => {
      child = execFile(process.execPath, ['--test', '--test-isolation=none', '--test-reporter=tap', file], {
        cwd: root, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' },
        timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, encoding: 'utf8'
      }, (error, stdout, stderr) => {
        result.output = `${stdout}\n${stderr}`.slice(0, 8000)
        if (error) result.error ??= error.message.slice(0, 2000)
        resolve(stdout)
      })
    })
    // Node's execFile AbortSignal uses SIGTERM even when killSignal is SIGKILL.
    // Electron can defer SIGTERM during blocking JS; kill this isolated runner
    // explicitly and drain close before deleting either temporary directory.
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    const abort = () => {
      result.error = `Behavior evaluation cancelled: ${String(signal?.reason)}`
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      const stdout = await execution
      const count = (name: string) => Number([...stdout.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm'))].at(-1)?.[1] ?? NaN)
      const passed = count('pass'), failed = count('fail'), cancelled = count('cancelled')
      result.passed = Number.isFinite(passed) ? passed : 0
      result.failed = Number.isFinite(failed) ? failed : 0
      result.completed = result.passed + result.failed
      if (!result.error && cases.length > 0 && count('tests') === cases.length && passed === cases.length
        && failed === 0 && cancelled === 0 && count('skipped') === 0 && count('todo') === 0) result.status = 'passed'
      else result.error ??= 'Behavior tests did not complete the expected assertions.'
    } finally {
      await closed
      signal?.removeEventListener('abort', abort)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  return result
}
