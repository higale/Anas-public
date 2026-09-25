import { describe, expect, it } from 'vitest'
import type { LanguagePackSummary } from '@shared/types'
import { profileDefaultsFromResources, resolveLanguagePack } from './languageStore'

const languages: LanguagePackSummary[] = [{
  code: 'en',
  name: 'English',
  builtIn: true
}, {
  code: 'zh-CN',
  name: '简体中文',
  builtIn: true
}, {
  code: 'custom',
  name: '自定义语言',
  builtIn: false
}]

describe('languageStore', () => {
  it('returns the configured language-pack code and _meta name', () => {
    expect(resolveLanguagePack('custom', 'en-US', languages)).toMatchObject({
      code: 'custom',
      name: '自定义语言'
    })
  })

  it('resolves the system preference against the available language packs', () => {
    expect(resolveLanguagePack('system', 'zh-CN', languages)).toMatchObject({
      code: 'zh-CN',
      name: '简体中文'
    })
  })

  it('builds localized profile defaults while leaving user-owned fields empty', () => {
    const profile = profileDefaultsFromResources('zh-CN', {
      en: {
        profile_defaults: {
          assistant: {
            role: 'English role',
            instructions: 'English instructions'
          }
        }
      },
      'zh-CN': {
        profile_defaults: {
          assistant: {
            role: '中文角色',
            instructions: '中文指令'
          }
        }
      }
    })

    expect(profile).toEqual({
      assistant: {
        name: 'Ananas',
        role: '中文角色',
        instructions: '中文指令',
        newAvatarPath: ''
      },
      user: {
        preferredName: '',
        personalInfo: ''
      }
    })
  })

  it('falls back individual localized profile defaults to English', () => {
    const profile = profileDefaultsFromResources('custom', {
      en: {
        profile_defaults: {
          assistant: {
            role: 'English role',
            instructions: 'English instructions'
          }
        }
      },
      custom: {
        profile_defaults: {
          assistant: { role: 'Custom role' }
        }
      }
    })

    expect(profile.assistant).toEqual({
      name: 'Ananas',
      role: 'Custom role',
      instructions: 'English instructions',
      newAvatarPath: ''
    })
  })
})
