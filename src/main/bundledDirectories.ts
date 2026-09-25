import { cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Refresh app-owned examples/resources without changing imported user copies. */
export async function mirrorBundledDirectories(source: string, target: string, validate: (path: string, name: string) => Promise<unknown>): Promise<void> {
  const stage = `${target}.mirror.tmp`
  const previous = `${target}.mirror.previous`
  await mkdir(dirname(target), { recursive: true })
  await rm(stage, { recursive: true, force: true })
  await rm(previous, { recursive: true, force: true })
  await mkdir(stage)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    await validate(join(source, entry.name), entry.name)
    await cp(join(source, entry.name), join(stage, entry.name), { recursive: true, errorOnExist: true, force: false })
  }
  const exists = await lstat(target).then(() => true, reason => {
    if (reason.code === 'ENOENT') return false
    throw reason
  })
  if (exists) await rename(target, previous)
  try {
    await rename(stage, target)
    await rm(previous, { recursive: true, force: true })
  } catch (reason) {
    if (exists) await rename(previous, target).catch(() => undefined)
    throw reason
  }
}
