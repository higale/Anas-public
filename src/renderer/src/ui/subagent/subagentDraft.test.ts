import { defaultSubagentConfig } from '@shared/subagentConfig'
import type { TFunction } from 'i18next'
import { describe, expect, it } from 'vitest'
import { createSubagentDraft } from './subagentDraft'

const t = ((key: string) => key) as TFunction

describe('subagent draft configuration', () => {
  it('uses bundled data defaults for a custom subagent', () => {
    const draft = createSubagentDraft(undefined, t)
    expect(draft).toMatchObject({
      capabilities: defaultSubagentConfig.capabilities,
      enabled: defaultSubagentConfig.enabled
    })
    draft.capabilities.mcp.servers.push({ id: 'draft-only', mode: 'all', tools: [] })
    expect(defaultSubagentConfig.capabilities.mcp.servers).not.toContainEqual(expect.objectContaining({ id: 'draft-only' }))
  })
})
