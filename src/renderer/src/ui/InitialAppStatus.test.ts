import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AppIssueTray, InitialAppGate } from './InitialAppStatus'
import { createInitialAppLoadSnapshot } from './initialAppLoad'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('InitialAppStatus', () => {
  it('renders a non-interactive loading state while critical resources are pending', () => {
    const html = renderToStaticMarkup(createElement(InitialAppGate, {
      snapshot: createInitialAppLoadSnapshot()
    }))

    expect(html).toContain('role="status"')
    expect(html).toContain('startup.loading')
    expect(html).not.toContain('<button')
  })

  it('shows file checking instead of a second-level recovery entry when startup fails', () => {
    const snapshot = createInitialAppLoadSnapshot()
    snapshot.projects = { phase: 'ready' }
    snapshot.config = { phase: 'error', error: 'Config unavailable' }
    const html = renderToStaticMarkup(createElement(InitialAppGate, {
      snapshot
    }))

    expect(html).toContain('role="status"')
    expect(html).toContain('recovery.checking')
    expect(html).not.toContain('<button')
  })

  it('shows optional failures in a separate non-blocking issue tray', () => {
    const snapshot = createInitialAppLoadSnapshot()
    snapshot.projects = { phase: 'ready' }
    snapshot.config = { phase: 'ready' }
    snapshot.inputHistory = { phase: 'ready' }
    snapshot.buildInfo = { phase: 'error', error: 'Build info unavailable' }
    snapshot.icon = { phase: 'ready' }
    const html = renderToStaticMarkup(createElement(AppIssueTray, {
      snapshot,
      onDismissAppError: vi.fn(),
      onRetry: vi.fn()
    }))

    expect(html).toContain('startup.app_issues')
    expect(html).toContain('startup.resource_build_info')
    expect(html).toContain('Build info unavailable')
    expect(html).not.toContain('startup.resource_config')
  })
})
