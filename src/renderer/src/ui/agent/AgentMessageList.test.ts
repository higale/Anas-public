import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMessage, AgentRunActivity } from '@shared/agentTypes'
import {
  AgentMessageList,
  formatCompactTokens,
  messageRetryAction
} from './AgentMessageList'
import type { AgentRunView } from './useAgentWorkspace'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const commonProps = {
  title: 'Thread',
  panelRef: { current: null },
  followOutputRef: { current: true },
  speech: { status: 'idle' as const },
  onSpeak: () => {}
}

const messages: AgentMessage[] = [{
  id: 'user-1',
  role: 'user',
  runId: 'run-1',
  content: [{ type: 'text', text: 'QUESTION' }]
}]

function activity(status: AgentRunActivity['status']): AgentRunActivity {
  return {
    runId: 'run-1',
    operation: 'agent',
    status,
    createdAt: '2026-08-04T10:00:00.000Z',
    updatedAt: '2026-08-04T10:00:01.000Z',
    models: [{
      id: 'model-1',
      round: 1,
      sequence: 1,
      status: status === 'running' ? 'running' : 'completed',
      text: 'LIVE_REPLY',
      reasoning: 'REASONING',
      toolCallIds: []
    }],
    tools: [],
    subagents: []
  }
}

function liveActivity(): AgentRunView {
  return { ...activity('running'), status: 'running', interrupts: [] }
}

describe('AgentMessageList', () => {
  it('keeps message actions and compact token formatting stable', () => {
    expect(messageRetryAction('user')).toBe('resend')
    expect(messageRetryAction('assistant')).toBe('regenerate')
    expect(formatCompactTokens(1_250)).toBe('1.3k')
    expect(formatCompactTokens(1_500_000)).toBe('1.5m')
  })

  it('renders a running model reply directly in the main timeline', () => {
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [],
      run: liveActivity()
    }))

    expect(html).toContain('LIVE_REPLY')
    expect(html).toContain('<span>round 1</span>')
    expect(html).toContain('agent-activity-model-message')
    expect(html).not.toContain('agent-process')
    expect(html).not.toContain('agent-activity-range collapsed')
    expect(html).toContain('agent-activity-range-status')
    expect(html).toContain('agent.run_replying')
    expect(html).not.toContain('agent-activity-range-toggle')
    expect(html).not.toContain('agent.collapse_activity')
  })

  it('does not render a message container for whitespace-only model text', () => {
    const run = liveActivity()
    run.models[0].text = '\n\n\n'
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [],
      run
    }))

    expect(html).toContain('<span class="agent-activity-summary-label">reasoning</span>')
    expect(html).not.toContain('agent-activity-model-message')
  })

  it('shows a completed reasoning summary after the reasoning title', () => {
    const run = liveActivity()
    run.models[0] = {
      ...run.models[0],
      status: 'completed',
      reasoningSummary: 'Checked the protocol response.'
    }
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [],
      run
    }))

    expect(html).toContain(
      '<span>reasoning</span><span class="agent-activity-argument">Checked the protocol response.</span>'
    )
    expect(html).toContain('<pre>REASONING</pre>')
  })

  it('shows an ellipsis when the reasoning summary repeats the full reasoning', () => {
    const run = liveActivity()
    run.models[0] = {
      ...run.models[0],
      status: 'completed',
      reasoningSummary: '  REASONING\n'
    }
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [],
      run
    }))

    expect(html).toContain(
      '<span>reasoning</span><span class="agent-activity-argument">...</span>'
    )
    expect(html).toContain('<pre>REASONING</pre>')
  })

  it('distinguishes a Skill shortcut from a generic file tool call', () => {
    const run = liveActivity()
    run.models[0].toolCallIds = ['read-skill-file-1']
    run.tools.push({
      call: {
        id: 'read-skill-file-1',
        name: 'read_file',
        args: { path: '/skills/summarize/SKILL.md' }
      },
      sequence: 2,
      status: 'running'
    })
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages: [{
        ...messages[0],
        skillInvocation: {
          name: 'summarize',
          args: 'topic',
          promptText: 'SKILL_PROMPT'
        }
      }],
      activities: [],
      run
    }))

    const skillInputSummary = html.match(
      /agent-activity-skill-input"><summary[^>]*>([\s\S]*?)<\/summary>/
    )?.[1] ?? ''
    const toolSummary = html.match(
      /agent-activity-tool"[^>]*><summary[^>]*>([\s\S]*?)<\/summary>/
    )?.[1] ?? ''
    expect(skillInputSummary).toContain('lucide-file-text')
    expect(skillInputSummary).not.toContain('lucide-wrench')
    expect(toolSummary).toContain('lucide-wrench')
  })

  it('renders recalled memory with the same expandable input treatment as a Skill', () => {
    const run = liveActivity()
    run.memoryRecalls = [{
      id: 'recall-1',
      sequence: 0,
      query: 'How should this project build?',
      promptText: '<relevant_memories>\nMEMORY_PROMPT\n</relevant_memories>',
      memoryCount: 1,
      agentName: 'general-purpose',
      createdAt: '2026-08-26T00:00:00.000Z'
    }]
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [],
      run
    }))

    expect(html).toContain('agent-activity-input agent-activity-memory-recall')
    expect(html).toContain('lucide-brain')
    expect(html).toContain('agent.memory_recall · general-purpose')
    expect(html).toContain('MEMORY_PROMPT')
  })

  it('does not allow an interrupted turn to collapse while approval is pending', () => {
    const run = activity('interrupted')
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [run]
    }))

    expect(html).toContain('agent-activity-range expanded')
    expect(html).toContain('agent-activity-range-status')
    expect(html).not.toContain('agent-activity-range-toggle')
    expect(html).not.toContain('agent.collapse_activity')
  })

  it('collapses completed intermediate activity before the persisted final message', () => {
    const run = activity('completed')
    run.models[0].messageId = 'assistant-1'
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages: [...messages, {
        id: 'assistant-1',
        role: 'assistant',
        runId: 'run-1',
        content: [{ type: 'text', text: 'FINAL_REPLY' }]
      }],
      activities: [run]
    }))

    expect(html).toContain('agent-activity-range collapsed')
    expect(html).toContain('1 model round · 0 tool calls')
    expect(html.indexOf('agent-activity-range collapsed')).toBeLessThan(html.indexOf('FINAL_REPLY'))
    expect(html).not.toContain('LIVE_REPLY')
  })

  it('keeps HTML-tagged model output visible instead of silently dropping it', () => {
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages: [...messages, {
        id: 'assistant-1',
        role: 'assistant',
        runId: 'run-1',
        content: [{
          type: 'text',
          text: '<think>\nTHINKING_CONTENT\n</think>\nFINAL_REPLY'
        }]
      }],
      activities: []
    }))

    expect(html).toContain('&lt;think&gt;')
    expect(html).toContain('THINKING_CONTENT')
    expect(html).toContain('FINAL_REPLY')
  })

  it('renders context compression metadata as fixed technical English', () => {
    const run = activity('completed')
    run.summaries = [{
      id: 'summary-1',
      sequence: 0,
      status: 'completed',
      summaryText: 'SUMMARY_CONTENT',
      firstPreservedActivitySequence: 1,
      inputTokensBefore: 12_500,
      inputTokensAfter: 4_000,
      createdAt: '2026-08-04T10:00:00.500Z'
    }]
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [run]
    }))

    expect(html).toContain('Context compressed #1')
    expect(html).toContain('≈ 13k → 4k tokens')
    expect(html).toContain('SUMMARY_CONTENT')
  })

  it('keeps failed activity expanded and exposes a bottom collapse control', () => {
    const run = activity('failed')
    run.error = 'RUN_ERROR'
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [run]
    }))

    expect(html).toContain('agent-activity-range expanded')
    expect(html).toContain('RUN_ERROR')
    expect(html).toContain('agent.collapse_activity')
  })

  it('localizes a model-call limit error and renders it only once', () => {
    const run = activity('failed')
    run.error = 'Model call limits exceeded: run level call limit reached with 1 model calls'
    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [run],
      error: run.error
    }))

    expect(html.match(/agent\.model_call_limit_reached_with_count/g)).toHaveLength(1)
    expect(html).not.toContain('Model call limits exceeded')
  })

  it('renders adjacent delegations as one compact subagent group', () => {
    const run: AgentRunView = {
      ...activity('running'),
      status: 'running',
      interrupts: []
    }
    run.tools.push({
      call: {
        id: 'start-subagent-1',
        name: 'start_subagent',
        args: { description: 'Research current framework behavior' }
      },
      sequence: 2,
      status: 'completed',
      output: JSON.stringify({ subagent_id: 'subagent-1' })
    }, {
      call: {
        id: 'start-subagent-2',
        name: 'start_subagent',
        args: { description: 'Review framework documentation' }
      },
      sequence: 3,
      status: 'completed',
      output: JSON.stringify({ subagent_id: 'subagent-2' })
    })
    run.subagents.push({
      id: 'subagent-1',
      name: 'web-researcher',
      sequence: 3,
      status: 'running'
    }, {
      id: 'subagent-2',
      name: 'docs-reviewer',
      sequence: 4,
      status: 'completed'
    })
    run.tools.push({
      call: {
        id: 'search-1',
        name: 'read_file',
        args: {
          path: 'framework.md',
          summary: 'Inspect framework integration'
        }
      },
      sequence: 5,
      status: 'running',
      subagentId: 'subagent-1'
    })

    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [],
      run
    }))
    const labeledTriggers = html.match(
      /<button class="agent-subagent-activity-trigger labeled"[^>]*>/g
    ) ?? []

    expect(html.match(/agent-activity-subagent-group/g)).toHaveLength(1)
    expect(labeledTriggers).toHaveLength(2)
    expect(html.match(/data-agent-subagent-trigger=""/g)).toHaveLength(2)
    expect(html).not.toContain('role="button"')
    expect(labeledTriggers.every((trigger) => !trigger.includes('data-state='))).toBe(true)
    expect(html).toContain('data-status="running"')
    expect(html).toContain('data-status="completed"')
    expect(html).toContain('web-researcher')
    expect(html).toContain('docs-reviewer')
    expect(html).toContain('Inspect framework integration')
    expect(html).not.toContain('call read_file')
    expect(html).toContain('Completed')
    expect(html).not.toContain('agent.call')
  })

  it('keeps a tool, its arguments, and its result collapsed by default', () => {
    const run = activity('running')
    run.tools.push({
      call: {
        id: 'search-1',
        name: 'read_file',
        args: { path: 'skills.md' }
      },
      sequence: 2,
      status: 'running',
      startedAt: '2026-08-04T10:00:00.000Z'
    })
    const renderRun = (): string => renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [run]
    }))
    const disclosureTag = (html: string, className: string): string =>
      html.match(new RegExp(`<details class="agent-activity-disclosure ${className}"[^>]*>`))?.[0] ?? ''

    let html = renderRun()
    expect(disclosureTag(html, 'agent-activity-tool')).not.toContain('open=""')
    expect(disclosureTag(html, 'agent-activity-arguments')).not.toContain('open=""')
    expect(disclosureTag(html, 'agent-activity-result')).toBe('')

    run.status = 'completed'
    run.models[0].status = 'completed'
    run.tools[0] = {
      ...run.tools[0],
      status: 'completed',
      output: 'SEARCH_RESULT',
      completedAt: '2026-08-04T10:00:00.010Z'
    }
    html = renderRun()
    expect(disclosureTag(html, 'agent-activity-tool')).not.toContain('open=""')
    expect(disclosureTag(html, 'agent-activity-arguments')).not.toContain('open=""')
    expect(disclosureTag(html, 'agent-activity-result')).not.toContain('open=""')

    run.models.push({
      id: 'model-2',
      sequence: 3,
      status: 'running',
      text: '',
      reasoning: 'FOLLOW_UP_REASONING',
      toolCallIds: []
    })
    html = renderRun()
    expect(disclosureTag(html, 'agent-activity-tool')).not.toContain('open=""')
    expect(disclosureTag(html, 'agent-activity-result')).not.toContain('open=""')
  })

  it('renders the concrete command shell with its terminal icon, name, and summary', () => {
    const run = activity('completed')
    run.tools.push({
      call: {
        id: 'shell-1',
        name: 'pwsh',
        args: {
          command: 'curl wttr.in/Shanghai',
          summary: 'Query Shanghai weather via wttr.in'
        }
      },
      sequence: 2,
      status: 'completed',
      startedAt: '2026-08-04T10:00:00.000Z',
      completedAt: '2026-08-04T10:00:00.312Z'
    })

    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [run]
    }))

    const toolSummary = html.match(/agent-activity-tool"><summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? ''
    expect(html).toContain('lucide-terminal')
    expect(html).toContain('<code>pwsh</code>')
    expect(toolSummary).toContain('Query Shanghai weather via wttr.in')
    expect(toolSummary).not.toContain('curl wttr.in/Shanghai')
    expect(html).not.toContain('agent.call')
  })

  it('renders http_request with its network icon, name, and URL summary', () => {
    const run = activity('completed')
    run.tools.push({
      call: {
        id: 'http-1',
        name: 'http_request',
        args: { url: 'https://example.com/image.png' }
      },
      sequence: 2,
      status: 'completed',
      startedAt: '2026-08-04T10:00:00.000Z',
      completedAt: '2026-08-04T10:00:00.056Z'
    })

    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [run]
    }))

    const toolSummary = html.match(/agent-activity-tool"><summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? ''
    expect(html).toContain('lucide-globe')
    expect(html).toContain('<code>http_request</code>')
    expect(toolSummary).toContain('https://example.com/image.png')
  })

  it('prefers a model-provided summary for every tool type', () => {
    const run = activity('completed')
    run.tools.push({
      call: {
        id: 'read-1',
        name: 'read_file',
        args: {
          summary: '读取应用配置文件',
          path: '/workspace/settings.json'
        }
      },
      sequence: 2,
      status: 'completed',
      startedAt: '2026-08-04T10:00:00.000Z',
      completedAt: '2026-08-04T10:00:00.010Z'
    })

    const html = renderToStaticMarkup(createElement(AgentMessageList, {
      ...commonProps,
      messages,
      activities: [run]
    }))

    const toolSummary = html.match(/agent-activity-tool"><summary[^>]*>([\s\S]*?)<\/summary>/)?.[1] ?? ''
    expect(toolSummary).toContain('读取应用配置文件')
    expect(toolSummary).not.toContain('/workspace/settings.json')
  })

})
