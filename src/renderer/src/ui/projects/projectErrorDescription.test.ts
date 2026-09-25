import { createInstance } from 'i18next'
import { describe, expect, it } from 'vitest'
import en from '../../../../../data/lang/en.json'
import zhCN from '../../../../../data/lang/zh-CN.json'
import { ProjectOperationFailure, unwrapProjectResult } from '@shared/projectOperation'
import { projectErrorDescription } from './projectErrorDescription'

describe('project failure localization', () => {
  it('uses the current UI language for the same serialized duplicate-name error', async () => {
    const i18n = createInstance()
    await i18n.init({ lng: 'zh-CN', resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } } })
    let failure: unknown
    try { unwrapProjectResult(JSON.parse('{"status":"error","error":{"code":"duplicate_name","name":"Existing"}}')) } catch (reason) { failure = reason }
    expect(projectErrorDescription(failure, i18n.t)).toContain('已存在名为“Existing”的项目')
    await i18n.changeLanguage('en')
    expect(projectErrorDescription(failure, i18n.t)).toContain('A project named “Existing” already exists')
  })

  it.each(['zh-CN', 'en'])('localizes file access and unknown errors in %s without showing IPC diagnostics', async (lng) => {
    const i18n = createInstance()
    await i18n.init({ lng, resources: { en: { translation: en }, 'zh-CN': { translation: zhCN } } })
    const message = projectErrorDescription(new ProjectOperationFailure({ code: 'permission_denied', path: '/project/data' }), i18n.t)
    expect(message).toContain(lng === 'en' ? 'permission' : '权限')
    expect(message).toContain('/project/data')
    const unexpected = projectErrorDescription(new Error("Error invoking remote method 'projects:create': English details"), i18n.t)
    expect(unexpected).toBe((lng === 'en' ? en : zhCN).project.errors.unexpected)
  })
})
