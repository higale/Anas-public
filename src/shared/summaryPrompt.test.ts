import { describe, expect, it } from 'vitest'
import { codingSummaryPrompt, summaryPrompt, summaryPromptForLanguage } from './summaryPrompt'

describe('summary prompt composition', () => {
  it.each([false, true])('selects the template and substitutes language without consuming conversation input (coding: %s)', (codingMode) => {
    const template = codingMode ? codingSummaryPrompt : summaryPrompt
    const prompt = summaryPromptForLanguage({ code: ' zh-CN ', name: ' 简体中文 ' }, codingMode)
    expect(prompt).toBe(template.replace('{output_language}', '简体中文 (zh-CN)'))
    expect(prompt).toContain('{conversation}')
    expect(prompt).not.toContain('{output_language}')
    expect(codingSummaryPrompt).not.toBe(summaryPrompt)
  })
})
