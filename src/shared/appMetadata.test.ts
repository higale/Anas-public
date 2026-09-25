import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applicationId } from './appMetadata'

describe('application metadata', () => {
  it('keeps the Windows runtime identity aligned with the packaged shortcut identity', () => {
    const builderConfig = readFileSync(join(process.cwd(), 'electron-builder.yml'), 'utf8')

    expect(builderConfig).toContain(`appId: ${applicationId}\n`)
  })
})
