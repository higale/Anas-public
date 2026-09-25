import { selectedTools } from '../test/toolPackageFixture'
import { describe, expect, it } from 'vitest'
import { customToolDefaults, parseCustomToolCommand, parseCustomTools, serializeCustomTool, validateCustomTool, validateCustomTools } from './customTools'
import { defaultCapabilities, intersectCapabilities, resolveSkillSelection } from './agentCapabilities'
import { maxCommandTimeoutSeconds } from './commandShell'

const definition = { ...customToolDefaults, id: 'stable-id', name: 'submit_result', description: 'Submit a result.',
  inputSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } }

describe('custom tool definitions', () => {
  it('round trips without persisting camelCase keys', () => {
    const raw = serializeCustomTool(validateCustomTool(definition))
    expect(raw).not.toHaveProperty('inputSchema')
    expect(raw).not.toHaveProperty('timeoutSeconds')
    expect(parseCustomTools([raw])).toEqual([definition])
  })
  it('defaults to pipe execution and preserves an explicit interactive choice', () => {
    expect(validateCustomTool({ ...definition, interactive: undefined }).interactive).toBe(false)
    expect(parseCustomTools([serializeCustomTool({ ...definition, interactive: true })])[0].interactive).toBe(true)
    expect(() => validateCustomTool({ ...definition, interactive: 'true' })).toThrow('boolean')
  })
  it.each(['read_file', 'start_subagent', 'mcp_service_tool', 'shell_custom', 'fish', '9bad', 'space name'])('rejects reserved or invalid tool name %s', (name) => {
    expect(() => validateCustomTool({ ...definition, name })).toThrow()
  })
  it('rejects malformed schemas, unresolved references, duplicate names and invalid timeouts', () => {
    for (const inputSchema of [{ type: 'array' }, { type: 'object', required: 'count' }, { type: 'object', properties: { value: { $ref: '#/missing' } } }]) {
      expect(() => validateCustomTool({ ...definition, inputSchema })).toThrow()
    }
    expect(() => validateCustomTools([definition, { ...definition, id: 'another', name: 'SUBMIT_RESULT' }])).toThrow('unique')
    for (const timeoutSeconds of [-1, maxCommandTimeoutSeconds + 1, 1.5, NaN, Infinity, '60', null]) expect(() => validateCustomTool({ ...definition, timeoutSeconds })).toThrow('Timeout')
  })
  it('defaults to no deadline and accepts explicit deadlines through the Shell timer limit', () => {
    expect(customToolDefaults.timeoutSeconds).toBe(0)
    for (const timeoutSeconds of [0, 1, 3601, maxCommandTimeoutSeconds]) {
      expect(parseCustomTools([serializeCustomTool(validateCustomTool({ ...definition, timeoutSeconds }))])[0].timeoutSeconds).toBe(timeoutSeconds)
    }
  })
  it('requires explicit selection and intersects the child against its parent limit', () => {
    expect(defaultCapabilities.customTools).toEqual({ project: false, entries: [] })
    const resolved = { ...defaultCapabilities, skills: resolveSkillSelection(defaultCapabilities.skills, []) }
    expect(intersectCapabilities({ ...resolved, customTools: selectedTools(['a', 'b']) }, { ...resolved, customTools: selectedTools(['b', 'c']) }).customTools).toEqual(selectedTools(['b']))
  })
  it('accepts the runtime schema dialect and rejects other declared versions when saving', () => {
    expect(validateCustomTool({ ...definition, inputSchema: { ...definition.inputSchema, $schema: 'https://json-schema.org/draft/2019-09/schema' } })).toBeDefined()
    for (const $schema of ['http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft/2020-12/schema']) {
      expect(() => validateCustomTool({ ...definition, inputSchema: { ...definition.inputSchema, $schema } })).toThrow('2019-09')
    }
  })
})

describe('custom command parsing', () => {
  it.each([
    ['C:\\data\\', 'daily report'],
    ['C:\\data\\\\', 'another directory\\'],
    ['\\\\server\\shared folder\\', '中文报告'],
    ['\\\\?\\C:\\data\\', 'extended path']
  ])('keeps the directory %s separate from following quoted arguments', (directory, label) => {
    expect(parseCustomToolCommand(`python submit.py --output "${directory}" --label "${label}" {{args}}`)).toEqual({
      executable: 'python', args: ['submit.py', '--output', directory, '--label', label, '{{args}}']
    })
    expect(parseCustomToolCommand(`python submit.py --output "${directory}" {{args}} --label "${label}"`).args)
      .toEqual(['submit.py', '--output', directory, '{{args}}', '--label', label])
  })
  it('groups literal quoted text without applying Shell expansion or escapes', () => {
    expect(parseCustomToolCommand('node --label="$name & (literal) # `text`" \'a "quote"\' "b\'quote" "" \'\' {{args}}').args)
      .toEqual(['--label=$name & (literal) # `text`', 'a "quote"', "b'quote", '', '', '{{args}}'])
  })
  it('preserves whitespace inside quotes and concatenates adjacent literal segments', () => {
    expect(parseCustomToolCommand('node\t--label=first" second"\' third\'\r\n"line 1\nline 2" {{args}}').args)
      .toEqual(['--label=first second third', 'line 1\nline 2', '{{args}}'])
  })
  it('preserves Windows paths, quotes, multiline arguments and empty fixed values', () => {
    expect(parseCustomToolCommand(String.raw`"C:\Program Files\node.exe" C:\tools\submit.js
      --mode validate --data {{args}} --empty "" --directory "C:\tools\"`)).toEqual({
      executable: String.raw`C:\Program Files\node.exe`,
      args: [String.raw`C:\tools\submit.js`, '--mode', 'validate', '--data', '{{args}}', '--empty', '', '--directory', 'C:\\tools\\']
    })
    expect(parseCustomToolCommand(`node 'script with spaces.js' --label 'a "quoted" title' {{args}}`).args)
      .toEqual(['script with spaces.js', '--label', 'a "quoted" title', '{{args}}'])
  })
  it.each(['', '"" {{args}}', 'node "unfinished {{args}}', "node 'unfinished {{args}}", 'node script.js', 'node {{args}} {{args}}',
    'node --data={{args}}', '{{args}} script.js', 'node {{args}} | more', 'node {{args}} > result.txt', 'node {{args}} && echo done',
    'node {{args}} # comment', 'node $SCRIPT {{args}}', 'node `date` {{args}}', 'node \0 {{args}}',
    'node "C:\\data\\" "unfinished {{args}}'])('rejects an ambiguous or unsupported command: %s', (command) => {
    expect(() => parseCustomToolCommand(command)).toThrow()
  })
})
