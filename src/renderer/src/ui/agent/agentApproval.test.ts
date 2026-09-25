import { describe, expect, it } from 'vitest'
import {
  approvalDescriptionKind,
  approvalResponses,
  interruptActions,
  rejectionResponses
} from './agentApproval'

const interrupts = [{
  id: 'approval-1',
  approvalGeneration: 'renderer-generation',
  pathPreviews: [{
    actionIndex: 0,
    locator: ['working_dir'],
    absolutePath: 'D:\\workspace\\project',
    source: 'relative' as const
  }, {
    actionIndex: 1,
    locator: ['path'],
    absolutePath: 'D:\\outside\\result.txt',
    source: 'relative' as const
  }],
  value: {
    anasSubagentApproval: { generation: 'generation-1' },
    actionRequests: [
      {
        name: 'pwsh',
        args: {
          command: 'npm test',
          working_dir: 'project',
          timeout: 120
        }
      },
      {
        name: 'apply_patch',
        args: { path: 'D:\\outside\\result.txt', content: 'done' }
      }
    ]
  }
}, {
  id: 'approval-2',
  approvalGeneration: 'renderer-generation',
  value: {
    actionRequests: [{
      name: 'read_file',
      args: { path: 'D:\\outside\\source.txt' },
      description: 'Read a host file outside the project folders.'
    }]
  }
}, {
  id: 'effect-recovery-1',
  approvalGeneration: 'renderer-generation',
  value: {
    actionRequests: [{
      name: 'delete_file',
      args: { path: 'D:\\workspace\\project\\old.txt' },
      description: 'The app stopped after entering the external operation boundary. The operation may already have happened, and retrying can repeat it.',
      anasRecovery: { ordinal: 2, state: 'uncertain' }
    }]
  }
}]

describe('agent approval model', () => {
  it('classifies built-in approval descriptions for renderer localization', () => {
    expect(approvalDescriptionKind('pwsh')).toBe('shell')
    expect(approvalDescriptionKind('apply_patch')).toBe('host_file')
    expect(approvalDescriptionKind('http_request')).toBe('host_file')
    expect(approvalDescriptionKind('update_config')).toBe('configuration')
    expect(approvalDescriptionKind('external_tool')).toBeUndefined()
  })

  it('extracts every requested action and its interrupt identifier', () => {
    const actions = interruptActions(interrupts)

    expect(actions).toHaveLength(4)
    expect(actions[0]).toMatchObject({
      interruptId: 'approval-1',
      approvalGeneration: 'renderer-generation',
      name: 'pwsh',
      args: {
        command: 'npm test',
        working_dir: 'project',
        timeout: 120
      },
      pathPreviews: [{
        actionIndex: 0,
        locator: ['working_dir'],
        absolutePath: 'D:\\workspace\\project',
        source: 'relative'
      }]
    })
    expect(actions[1].pathPreviews).toEqual([expect.objectContaining({
      actionIndex: 1,
      locator: ['path']
    })])
    expect(actions[2]).toMatchObject({
      interruptId: 'approval-2',
      name: 'read_file',
      description: 'Read a host file outside the project folders.'
    })
    expect(actions[3]).toMatchObject({
      interruptId: 'effect-recovery-1',
      name: 'delete_file',
      recovery: { ordinal: 2, state: 'uncertain' }
    })
  })

  it('approves every action while preserving interrupt groups and order', () => {
    const actions = interruptActions(interrupts)

    expect(approvalResponses(actions)).toEqual([
      {
        interruptId: 'approval-1',
        decisions: [{ type: 'approve' }, { type: 'approve' }],
        expectedGeneration: 'renderer-generation'
      },
      {
        interruptId: 'approval-2',
        decisions: [{ type: 'approve' }],
        expectedGeneration: 'renderer-generation'
      },
      {
        interruptId: 'effect-recovery-1',
        decisions: [{ type: 'approve' }],
        expectedGeneration: 'renderer-generation'
      }
    ])
  })

  it('identifies every rejected tool before attaching the trimmed user guidance', () => {
    expect(rejectionResponses(
      interruptActions(interrupts),
      '  Keep all files inside the project.  '
    )).toEqual([
      {
        interruptId: 'approval-1',
        expectedGeneration: 'renderer-generation',
        decisions: [
          {
            type: 'reject',
            message: 'User rejected the tool call for `pwsh`.\nUser feedback: Keep all files inside the project.'
          },
          {
            type: 'reject',
            message: 'User rejected the tool call for `apply_patch`.\nUser feedback: Keep all files inside the project.'
          }
        ]
      },
      {
        interruptId: 'approval-2',
        expectedGeneration: 'renderer-generation',
        decisions: [
          {
            type: 'reject',
            message: 'User rejected the tool call for `read_file`.\nUser feedback: Keep all files inside the project.'
          }
        ]
      },
      {
        interruptId: 'effect-recovery-1',
        expectedGeneration: 'renderer-generation',
        decisions: [
          {
            type: 'reject',
            message: 'User rejected the tool call for `delete_file`.\nUser feedback: Keep all files inside the project.'
          }
        ]
      }
    ])
  })

  it('omits empty rejection guidance', () => {
    expect(rejectionResponses(interruptActions(interrupts))[0].decisions).toEqual([
      { type: 'reject' },
      { type: 'reject' }
    ])
  })

  it('ignores malformed recovery metadata instead of changing approval semantics', () => {
    const [action] = interruptActions([{
      id: 'malformed-recovery',
      approvalGeneration: 'malformed-generation',
      value: {
        actionRequests: [{
          name: 'pwsh',
          args: { command: 'echo ok' },
          anasRecovery: { ordinal: 0, state: 'uncertain' }
        }]
      }
    }])

    expect(action.recovery).toBeUndefined()
  })
})
