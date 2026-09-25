import { fireEvent, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const previewMocks = vi.hoisted(() => ({
  loadAttachmentPreview: vi.fn(),
  showItemInFolder: vi.fn()
}))

vi.mock('./attachmentPreviewLoader', () => previewMocks)

import { MarkdownText, MarkdownWorkspaceProjectProvider } from './MarkdownText'

beforeEach(() => {
  Object.defineProperty(window, 'gale', {
    configurable: true,
    value: { files: { showItemInFolder: previewMocks.showItemInFolder.mockReset().mockResolvedValue('') } }
  })
  previewMocks.loadAttachmentPreview.mockReset().mockResolvedValue({
    path: '/workspace/images/avatar.png',
    mimeType: 'image/png',
    src: 'data:image/png;base64,AQ=='
  })
})

describe('Markdown workspace images', () => {
  it.each([false, true])('reveals the resolved image file while original loading is pending: %s', async (pending) => {
    const resolvedPath = 'D:\\workspace\\images\\avatar.png'
    previewMocks.loadAttachmentPreview.mockImplementation(async (_path, options) => {
      if (pending && options.mode === 'original') return new Promise(() => {})
      return {
        path: resolvedPath,
        mimeType: 'image/png',
        src: options.mode === 'original' ? 'anas-image://local/avatar' : 'data:image/png;base64,AQ=='
      }
    })
    const view = render(
      <MarkdownWorkspaceProjectProvider projectId="project-a">
        <MarkdownText text="![Avatar](images/avatar.png)" />
      </MarkdownWorkspaceProjectProvider>
    )

    fireEvent.click(await view.findByRole('button', { name: 'Avatar' }))
    if (!pending) {
      await waitFor(() => expect(view.getByRole('dialog').querySelector('img'))
        .toHaveAttribute('src', 'anas-image://local/avatar'))
    }
    fireEvent.click(await view.findByRole('button', { name: 'chat.show_attachment_in_folder' }))

    await waitFor(() => expect(previewMocks.showItemInFolder).toHaveBeenCalledWith(resolvedPath))
  })

  it('loads a relative image through the current project context', async () => {
    const view = render(
      <MarkdownWorkspaceProjectProvider projectId="project-a">
        <MarkdownText text="![Avatar](images/avatar.png)" />
      </MarkdownWorkspaceProjectProvider>
    )

    await waitFor(() => expect(previewMocks.loadAttachmentPreview).toHaveBeenCalledWith(
      'images/avatar.png',
      { mode: 'thumbnail', projectId: 'project-a' }
    ))
    await waitFor(() => expect(view.getByRole('img', { name: 'Avatar' }))
      .toHaveAttribute('src', 'data:image/png;base64,AQ=='))
  })
})

describe('Markdown document navigation', () => {
  it('keeps slash commands as code in documents while chat still links local paths', () => {
    const text = '`/name@user arguments`\n\n`/workspace/file.md`\n\n[Guide](./USER_GUIDE.en.md)'
    const view = render(<MarkdownText text={text} onNavigate={vi.fn()} />)
    expect(view.getAllByRole('link')).toHaveLength(1)
    expect(view.getByText('/name@user arguments').tagName).toBe('CODE')
    expect(view.getByText('/workspace/file.md').tagName).toBe('CODE')

    view.rerender(<MarkdownText text={text} />)
    expect(view.getByRole('link', { name: '/workspace/file.md' })).toHaveAttribute('href', expect.stringContaining('anas-local-file:'))
  })
})
