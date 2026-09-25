import { describe, expect, it } from 'vitest'
import { parseSlashSkillInput } from './skillShortcuts'

describe('parseSlashSkillInput', () => {
  it('separates a skill name from its arguments', () => {
    expect(parseSlashSkillInput('/weather Beijing tomorrow')).toEqual({
      name: 'weather',
      args: 'Beijing tomorrow'
    })
  })

  it('parses a qualified source alias', () => {
    expect(parseSlashSkillInput('/weather@agents Beijing')).toEqual({
      name: 'weather',
      sourceAlias: 'agents',
      args: 'Beijing'
    })
  })

  it('rejects an empty command and invalid names', () => {
    expect(parseSlashSkillInput('/')).toBeUndefined()
    expect(parseSlashSkillInput('/bad.name value')).toBeUndefined()
    expect(parseSlashSkillInput('/weather@ value')).toBeUndefined()
    expect(parseSlashSkillInput('/weather@bad.alias value')).toBeUndefined()
  })
})
