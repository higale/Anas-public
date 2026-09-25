import { describe, expect, it } from 'vitest'
import { localFilePathFromHref, remarkLocalFileLinks } from './localFileLinks'

interface TestNode {
  type: string
  value?: string
  url?: string
  children?: TestNode[]
}

function transform(value: string): TestNode {
  const tree: TestNode = {
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }]
  }
  remarkLocalFileLinks()(tree)
  return tree
}

describe('local file links', () => {
  it('links a labeled Windows file path and preserves its label', () => {
    const tree = transform('文件路径：C:\\Users\\user\\Desktop\\cute cat.png')
    const children = tree.children?.[0].children ?? []

    expect(children[0]).toEqual({ type: 'text', value: '文件路径：' })
    expect(children[1]).toMatchObject({
      type: 'link',
      children: [{ type: 'text', value: 'C:\\Users\\user\\Desktop\\cute cat.png' }]
    })
    expect(localFilePathFromHref(children[1].url)).toBe('C:\\Users\\user\\Desktop\\cute cat.png')
  })

  it('links standalone Windows, UNC, and POSIX paths', () => {
    for (const path of [
      'D:\\Downloads\\report.pdf',
      '\\\\server\\share\\report.pdf',
      '/home/user/report.pdf'
    ]) {
      const link = transform(path).children?.[0].children?.[0]
      expect(link?.type).toBe('link')
      expect(localFilePathFromHref(link?.url)).toBe(path)
    }
  })

  it('does not link paths embedded in ordinary prose or existing links', () => {
    const prose = transform('Saved to C:\\Users\\user\\Desktop\\cute_cat.png successfully.')
    expect(prose.children?.[0].children).toEqual([{
      type: 'text',
      value: 'Saved to C:\\Users\\user\\Desktop\\cute_cat.png successfully.'
    }])

    const tree: TestNode = {
      type: 'root',
      children: [{
        type: 'link',
        url: 'https://example.com',
        children: [{ type: 'text', value: 'C:\\existing\\link.txt' }]
      }]
    }
    remarkLocalFileLinks()(tree)
    expect(tree.children?.[0].url).toBe('https://example.com')
    expect(tree.children?.[0].children?.[0].type).toBe('text')
  })

  it('links an inline-code path without touching code blocks', () => {
    const tree: TestNode = {
      type: 'root',
      children: [{ type: 'inlineCode', value: 'C:\\Users\\user\\report.txt' }, {
        type: 'code',
        value: 'C:\\Users\\user\\script.ps1'
      }]
    }
    remarkLocalFileLinks()(tree)

    expect(tree.children?.[0]).toMatchObject({
      type: 'link',
      children: [{ type: 'text', value: 'C:\\Users\\user\\report.txt' }]
    })
    expect(tree.children?.[1]).toEqual({
      type: 'code',
      value: 'C:\\Users\\user\\script.ps1'
    })
  })
})
