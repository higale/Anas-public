import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UserInputSnapshot } from '@shared/userInput'
import { UserInputDialog } from './UserInputDialog'

vi.mock('react-i18next', () => {
  const t = (key: string, values?: Record<string, unknown>) => values ? `${key} ${Object.values(values).join(' ')}` : key
  return { useTranslation: () => ({ t }) }
})

let snapshot: UserInputSnapshot
let listener: (value: UserInputSnapshot) => void
const respond = vi.fn(), shown = vi.fn(), interact = vi.fn()
beforeEach(() => {
  snapshot = { revision: 1, requests: [{ id: 'request', threadId: 'thread', runId: 'run',
    source: { projectName: 'Project A', threadTitle: 'Conversation A' },
    requireResponse: false, interacted: false, timeoutSeconds: 60, deadline: Date.now() + 60_000,
    questions: [{ id: 'format', question: 'Choose format', options: [{ label: 'PDF' }, { label: 'Markdown' }] }] }] }
  shown.mockReset().mockResolvedValue(true)
  interact.mockReset().mockImplementation(async (id: string) => {
    snapshot = { revision: snapshot.revision + 1, requests: snapshot.requests.map(request => request.id === id ? { ...request, interacted: true, deadline: undefined } : request) }
    listener(snapshot)
    return true
  })
  respond.mockReset().mockImplementation(async (id: string) => {
    snapshot = { revision: snapshot.revision + 1, requests: snapshot.requests.filter(request => request.id !== id) }
    listener(snapshot)
    return true
  })
  Object.defineProperty(window, 'gale', { configurable: true, value: { agent: { userInput: {
    list: async () => snapshot, shown, respond, interact,
    onChange: (next: typeof listener) => { listener = next; return () => undefined }
  } } } })
})
afterEach(() => vi.useRealTimers())

it('requires an explicit answer, lets Other replace a radio choice, and closes after submission', async () => {
  render(<UserInputDialog />)
  await screen.findByRole('dialog')
  expect(shown).toHaveBeenCalledWith('request')
  const submit = screen.getByRole('button', { name: 'agent.user_input_submit' })
  expect(submit).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: 'PDF' }))
  expect(submit).toBeEnabled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'HTML' } })
  expect(screen.getByRole('radio', { name: 'PDF' })).not.toBeChecked()
  fireEvent.click(submit)
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(respond).toHaveBeenCalledWith('request', { status: 'answered', answers: [
    { question_id: 'format', selected_options: [], other: 'HTML' }
  ] })
})

it('supports multiple options together with additional text', async () => {
  snapshot.requests[0].questions[0].multiple = true
  render(<UserInputDialog />)
  await screen.findByRole('dialog')
  fireEvent.click(screen.getByRole('checkbox', { name: 'PDF' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Markdown' }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Include HTML too' } })
  fireEvent.click(screen.getByRole('button', { name: 'agent.user_input_submit' }))
  expect(respond).toHaveBeenCalledWith('request', { status: 'answered', answers: [
    { question_id: 'format', selected_options: ['PDF', 'Markdown'], other: 'Include HTML too' }
  ] })
})

it('counts down against the deadline and removes the form when the main process expires it', async () => {
  vi.useFakeTimers()
  delete snapshot.requests[0].deadline
  await act(async () => { render(<UserInputDialog />) })
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  act(() => listener({ revision: 2, requests: [{ ...snapshot.requests[0], deadline: Date.now() + 60_000 }] }))
  expect(screen.getByRole('timer')).toHaveTextContent('60')
  await act(async () => { await vi.advanceTimersByTimeAsync(12_000) })
  expect(screen.getByRole('timer')).toHaveTextContent('48')
  await act(async () => { await vi.advanceTimersByTimeAsync(48_000) })
  expect(screen.getByRole('button', { name: 'agent.user_input_submit' })).toBeDisabled()
  act(() => listener({ revision: 3, requests: [] }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(respond).not.toHaveBeenCalled()
})

it.each(['pointer', 'keyboard', 'change', 'composition', 'scroll'])('cancels the countdown on %s interaction and keeps the draft editable', async kind => {
  vi.useFakeTimers()
  await act(async () => { render(<UserInputDialog />) })
  expect(interact).not.toHaveBeenCalled()
  fireEvent.mouseMove(screen.getByRole('dialog'))
  expect(interact).not.toHaveBeenCalled()
  const input = screen.getByRole('textbox')
  act(() => {
    if (kind === 'pointer') fireEvent.pointerDown(input)
    else if (kind === 'keyboard') fireEvent.keyDown(input, { key: 'Tab' })
    else if (kind === 'change') fireEvent.change(input, { target: { value: 'Draft' } })
    else if (kind === 'composition') fireEvent.compositionStart(input)
    else fireEvent.wheel(screen.getByRole('dialog'))
  })
  expect(interact).toHaveBeenCalledWith('request')
  expect(screen.getByRole('timer')).toHaveTextContent('agent.user_input_waiting')
  fireEvent.change(input, { target: { value: 'Still writing' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(600_000) })
  expect(input).toHaveValue('Still writing')
  expect(input).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'agent.user_input_submit' }))
  expect(respond).toHaveBeenCalledWith('request', { status: 'answered', answers: [
    { question_id: 'format', selected_options: [], other: 'Still writing' }
  ] })
})

it('has no countdown when an answer is required, and Escape cancels the request', async () => {
  snapshot.requests[0].requireResponse = true
  delete snapshot.requests[0].deadline
  render(<UserInputDialog />)
  await screen.findByRole('dialog')
  expect(screen.getByRole('timer')).toHaveTextContent('agent.user_input_waiting')
  fireEvent.keyDown(document, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(respond).toHaveBeenCalledWith('request', { status: 'cancelled' })
})

it('keeps the answer draft when Escape cancels IME composition, then accepts ordinary Escape', async () => {
  render(<UserInputDialog />)
  const input = await screen.findByRole('textbox')
  fireEvent.change(input, { target: { value: '保留已输入内容' } })
  fireEvent.compositionStart(input)
  fireEvent.keyDown(input, { key: 'Escape', isComposing: true })
  expect(screen.getByRole('dialog')).toBeVisible()
  expect(input).toHaveValue('保留已输入内容')
  expect(respond).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Escape', isComposing: false })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(respond).toHaveBeenCalledWith('request', { status: 'cancelled' })
})

it('identifies each queued request and resets the form when advancing to a different agent', async () => {
  snapshot.requests[0].source.agentName = 'Researcher'
  snapshot.requests.push({ ...snapshot.requests[0], id: 'second', threadId: 'another-thread', runId: 'another-run',
    source: { projectName: 'Project B', threadTitle: 'Conversation B', agentName: 'Reviewer' } })
  render(<UserInputDialog />)
  expect(await screen.findByText('agent.user_input_source Project A Conversation A')).toBeVisible()
  expect(screen.getByText('agent.user_input_agent Researcher')).toBeVisible()
  expect(screen.getByText('agent.user_input_pending 1')).toBeVisible()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First answer' } })
  fireEvent.click(screen.getByRole('button', { name: 'agent.user_input_submit' }))
  expect(await screen.findByText('agent.user_input_source Project B Conversation B')).toBeVisible()
  expect(screen.getByText('agent.user_input_agent Reviewer')).toBeVisible()
  expect(screen.queryByText('agent.user_input_pending 1')).toBeNull()
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(screen.getByRole('timer')).toHaveTextContent('60')
  expect(respond).toHaveBeenLastCalledWith('request', { status: 'answered', answers: [
    { question_id: 'format', selected_options: [], other: 'First answer' }
  ] })
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
  expect(respond).toHaveBeenLastCalledWith('second', { status: 'cancelled' })
})

it('ignores a stale initial snapshot after a request has already settled', async () => {
  let resolve!: (value: UserInputSnapshot) => void
  window.gale.agent.userInput.list = () => new Promise(done => { resolve = done })
  render(<UserInputDialog />)
  act(() => listener({ revision: 2, requests: [] }))
  await act(async () => resolve(snapshot))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(shown).not.toHaveBeenCalled()
})
