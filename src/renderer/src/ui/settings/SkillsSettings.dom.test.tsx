import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GaleApi, SkillSnapshot } from '@shared/types'
import { SkillsSettings } from './SkillsSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number; name?: string }) => {
      const value = values?.count ?? values?.name
      return value === undefined ? key : `${key}:${value}`
    }
  })
}))

const listFiles = vi.fn()
const readFile = vi.fn()
const updateScriptApproval = vi.fn()
const showItemInFolder = vi.fn()

beforeEach(() => {
  listFiles.mockReset()
  readFile.mockReset()
  listFiles.mockResolvedValue([{
    name: 'SKILL.md',
    path: '/skills/system/config/SKILL.md',
    relativePath: 'SKILL.md',
    kind: 'text',
    size: 10
  }])
  Object.defineProperty(window, 'gale', {
    configurable: true,
    value: { skills: { listFiles, readFile }, files: { showItemInFolder } } as unknown as GaleApi
  })
})

const snapshot: SkillSnapshot = {
  scriptAutoApprove: false,
  roots: [
    { id: 'system', kind: 'system', name: 'System', shortcutAlias: 'system', path: '/skills/system', removable: false, available: true },
    { id: 'user', kind: 'user', name: 'User', shortcutAlias: 'user', path: '/skills/user', removable: false, available: true }
  ],
  skills: [{
    id: 'system:config',
    rootId: 'system',
    name: 'config',
    description: 'Configure the application.',
    scriptAutoApprove: false,
    modelAvailable: true,
    userAvailable: true,
    dirPath: '/skills/system/config',
    linked: false,
    relativePath: 'config',
    source: 'system',
    rootName: 'System',
    shortcutAlias: 'system',
    shortcut: '/config'
  }]
}

function renderSkills(onImportDirectories = vi.fn(), skills = snapshot): void {
  render(
    <SkillsSettings
      sectionClass="settings-section"
      skills={skills}
      onAddDirectory={vi.fn()}
      onImportDirectories={onImportDirectories}
      onMoveDirectory={vi.fn()}
      onRefresh={vi.fn()}
      onRemoveDirectory={vi.fn()}
      onUpdateDirectory={vi.fn()}
      onUpdateScriptApproval={updateScriptApproval}
      onUpdateAvailability={vi.fn()}
    />
  )
}

describe('Skills settings tree', () => {
  it.each([false, true])('marks only individually exempt Skills when global approval is %s', async (globalApproval) => {
    const user = userEvent.setup()
    renderSkills(vi.fn(), {
      ...snapshot,
      scriptAutoApprove: globalApproval,
      skills: [
        snapshot.skills[0],
        { ...snapshot.skills[0], id: 'system:exempt', name: 'exempt', scriptAutoApprove: true }
      ]
    })
    await user.click(screen.getByRole('button', { name: /settings\.skill_group_all/ }))
    expect(screen.getByRole('button', { name: /^config\s*@system$/ })).toBeVisible()
    expect(screen.getByRole('button', { name: 'exempt · @system · settings.skill_scripts_auto_approve' })).toBeVisible()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('replaces the Skill open button with script approval and reveals its clickable location', async () => {
    const user = userEvent.setup()
    renderSkills(vi.fn(), { ...snapshot, scriptAutoApprove: true })
    await user.click(screen.getByRole('button', { name: /settings\.skill_group_all/ }))
    await user.click(screen.getByText('config', { selector: '.settings-skill-tree-select > span' }))
    const checkbox = screen.getByRole('checkbox', { name: 'settings.skill_scripts_auto_approve' })
    expect(checkbox).not.toBeChecked()
    expect(screen.getByText('settings.skill_scripts_auto_approve_global_active')).toBeVisible()
    await user.click(checkbox)
    expect(updateScriptApproval).toHaveBeenCalledWith('system:config', true)
    expect(screen.queryByRole('button', { name: 'common.open' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '/skills/system/config' }))
    expect(showItemInFolder).toHaveBeenCalledWith('/skills/system/config')
    expect(screen.getByText('/config')).toBeVisible()
  })

  it('shows global sources without a project placeholder', () => {
    renderSkills()
    expect(screen.queryByRole('button', { name: /settings\.skill_group_project/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /settings\.skill_group_system/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /settings\.skill_group_user/ })).toBeInTheDocument()
  })

  it('shows Skill counts for every group', () => {
    renderSkills()

    const systemRoot = screen.getByRole('button', { name: /settings\.skill_group_system/ })
    const userRoot = screen.getByRole('button', { name: /settings\.skill_group_user/ })

    expect(within(systemRoot).getByText('1')).toBeInTheDocument()
    expect(within(userRoot).getByText('0')).toBeInTheDocument()
    expect(systemRoot).not.toHaveTextContent('@system')
    expect(userRoot).not.toHaveTextContent('@user')
  })

  it('starts collapsed without a selection and selects All Skills when expanded', async () => {
    const user = userEvent.setup()
    renderSkills()

    const allSkills = screen.getByRole('button', { name: /settings\.skill_group_all/ })
    expect(document.querySelector('.settings-skill-tree-select')).not.toBeInTheDocument()
    expect(allSkills).not.toHaveClass('active')
    expect(screen.getByText('settings.select_skill_tree_item')).toBeInTheDocument()

    await user.click(allSkills)

    expect(allSkills).toHaveClass('active')
    expect(document.querySelector('.settings-skill-tree-select')).toBeInTheDocument()
    expect(screen.getByText('settings.skill_total:1')).toBeInTheDocument()

    await user.click(allSkills)

    expect(allSkills).toHaveClass('active')
    expect(document.querySelector('.settings-skill-tree-select')).not.toBeInTheDocument()
  })

  it('selects a Skill from its label and expands it only from the disclosure button', async () => {
    const user = userEvent.setup()
    renderSkills()

    await user.click(screen.getByRole('button', { name: /settings\.skill_group_all/ }))
    const skill = screen.getByText('config', { selector: '.settings-skill-tree-select > span' }).closest('button')
    if (!skill) throw new Error('Skill selection button was not rendered.')
    await user.click(skill)

    expect(listFiles).not.toHaveBeenCalled()
    expect(skill.parentElement).toHaveClass('active')
    expect(screen.getByText('Configure the application.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'SKILL.md' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'settings.skill_expand:config' }))

    expect(listFiles).toHaveBeenCalledWith(undefined, 'system:config', undefined)
    expect(screen.getByRole('button', { name: 'SKILL.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.skill_collapse:config' })).toBeInTheDocument()
  })

  it('offers import only while the Anas User root is selected', async () => {
    const user = userEvent.setup()
    const onImportDirectories = vi.fn()
    renderSkills(onImportDirectories)

    expect(screen.queryByRole('button', { name: 'settings.import_skill' })).not.toBeInTheDocument()
    const userRoot = screen.getByText('settings.skill_group_user').closest('button')
    if (!userRoot) throw new Error('Anas User root button was not rendered.')
    await user.click(userRoot)

    const importButton = screen.getByRole('button', { name: 'settings.import_skill' })
    await user.click(importButton)
    expect(onImportDirectories).toHaveBeenCalledOnce()
  })

  it('orders All Skills by root order and then by name within each root', async () => {
    const user = userEvent.setup()
    const groupedSnapshot: SkillSnapshot = {
  scriptAutoApprove: false,
      roots: [
        ...snapshot.roots,
        { id: 'external', kind: 'external', name: 'External', shortcutAlias: 'external', path: '/skills/external', removable: true, available: true }
      ],
      skills: [
        { ...snapshot.skills[0], id: 'external:alpha', rootId: 'external', name: 'alpha', source: 'external', rootName: 'External', shortcutAlias: 'external' },
        { ...snapshot.skills[0], id: 'user:zeta', rootId: 'user', name: 'zeta', source: 'user', rootName: 'User', shortcutAlias: 'user' },
        { ...snapshot.skills[0], id: 'system:zulu', name: 'zulu' },
        { ...snapshot.skills[0], id: 'user:beta', rootId: 'user', name: 'beta', source: 'user', rootName: 'User', shortcutAlias: 'user' },
        { ...snapshot.skills[0], id: 'system:alpha', name: 'alpha' }
      ]
    }
    renderSkills(vi.fn(), groupedSnapshot)

    await user.click(screen.getByRole('button', { name: /settings\.skill_group_all/ }))

    const labels = [...document.querySelectorAll('.settings-skill-tree-select > span')].map((node) => node.textContent)
    expect(labels).toEqual(['alpha', 'zulu', 'beta', 'zeta', 'alpha'])
  })

  it('keeps an older file read from replacing the currently selected preview', async () => {
    const user = userEvent.setup()
    let resolveFirst: ((value: unknown) => void) | undefined
    let resolveSecond: ((value: unknown) => void) | undefined
    const firstPreview = new Promise((resolve) => { resolveFirst = resolve })
    const secondPreview = new Promise((resolve) => { resolveSecond = resolve })
    const twoSkills: SkillSnapshot = {
  scriptAutoApprove: false,
      roots: snapshot.roots,
      skills: [
        { ...snapshot.skills[0], id: 'system:first', name: 'first' },
        { ...snapshot.skills[0], id: 'system:second', name: 'second' }
      ]
    }
    listFiles.mockImplementation(async (_projectId, skillId: string) => [{
      name: 'notes.md',
      path: `/skills/${skillId}/notes.md`,
      relativePath: 'notes.md',
      kind: 'text',
      size: 10
    }])
    readFile.mockImplementation(async (_projectId, skillId: string) => (
      skillId === 'system:first' ? firstPreview : secondPreview
    ))
    renderSkills(vi.fn(), twoSkills)
    await user.click(screen.getByRole('button', { name: /settings\.skill_group_all/ }))
    await user.click(screen.getByRole('button', { name: 'settings.skill_expand:first' }))
    await user.click(screen.getByRole('button', { name: 'settings.skill_expand:second' }))
    const files = screen.getAllByRole('button', { name: 'notes.md' })

    await user.click(files[0])
    await user.click(files[1])
    await act(async () => resolveSecond?.({
      skillId: 'system:second', name: 'notes.md', path: '/second/notes.md', relativePath: 'notes.md',
      resolvedPath: '/second/notes.md', size: 10, kind: 'text', content: 'second content'
    }))
    expect(screen.getByText('second content')).toBeInTheDocument()

    await act(async () => resolveFirst?.({
      skillId: 'system:first', name: 'notes.md', path: '/first/notes.md', relativePath: 'notes.md',
      resolvedPath: '/first/notes.md', size: 10, kind: 'text', content: 'first content'
    }))
    expect(screen.getByText('second content')).toBeInTheDocument()
    expect(screen.queryByText('first content')).not.toBeInTheDocument()
  })
})
