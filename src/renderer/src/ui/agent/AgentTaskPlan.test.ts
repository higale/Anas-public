import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AgentTaskPlan, agentTaskPlanSummary } from './AgentTaskPlan'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('agentTaskPlanSummary', () => {
  it('reports completed progress', () => {
    expect(agentTaskPlanSummary([
      { content: 'Done', status: 'completed' },
      { content: 'Later', status: 'pending' },
      { content: 'Now', status: 'in_progress' }
    ])).toEqual({
      completed: 1,
      total: 3
    })
  })

  it('reports a fully completed plan', () => {
    expect(agentTaskPlanSummary([
      { content: 'Done', status: 'completed' }
    ])).toEqual({
      completed: 1,
      total: 1
    })
  })

  it('keeps the native popover trigger out of sequential focus', () => {
    const html = renderToStaticMarkup(createElement(AgentTaskPlan, {
      active: true,
      todos: [{ content: 'Current step', status: 'in_progress' }]
    }))

    expect(html).toContain('<button')
    expect(html).toContain('aria-haspopup="dialog"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('tabindex="-1"')
    expect(html).not.toContain('role="button"')
  })
})
