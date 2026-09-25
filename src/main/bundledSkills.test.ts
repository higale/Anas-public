import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateRestoredSkillsDirectory } from './skillsStore'

describe('bundled Skills', () => {
  it('ships valid system and example Skill directories', async () => {
    const systemRoot = resolve('data/skills_system')
    const exampleRoot = resolve('data/skills_examples')

    await expect(validateRestoredSkillsDirectory(systemRoot)).resolves.toBeUndefined()
    await expect(validateRestoredSkillsDirectory(exampleRoot)).resolves.toBeUndefined()
    await expect(readdir(systemRoot)).resolves.toEqual(expect.arrayContaining([
      'config',
      'skill-creator',
      'skill-installer'
    ]))
  })
})
