import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import fs from 'stubborn-fs'

export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  const targetDir = dirname(path)
  const temp = join(targetDir, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`)
  await mkdir(targetDir, { recursive: true })
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    // Windows readers and file scanners can briefly deny an atomic replacement.
    // Retry that same rename within a deadline; never remove the current config.
    await fs.retry.rename({ timeout: 2_000, interval: 25 })(temp, path)
  } catch (reason) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw reason
  }
}
