import { afterEach, describe, expect, it } from 'vitest'
import { allowsNativeContextMenu, installNativeContextMenuPolicy } from './nativeContextMenuPolicy'

function rightClickIsAllowed(element: Element): boolean {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  return element.dispatchEvent(event)
}

afterEach(() => document.body.replaceChildren())

describe('native context menu policy', () => {
  it('allows text editing controls', () => {
    document.body.innerHTML = `
      <input id="text" type="text">
      <input id="number" type="number">
      <textarea id="textarea"></textarea>
      <div id="editor" contenteditable="true"><span id="editor-child">draft</span></div>
    `

    for (const id of ['text', 'number', 'textarea', 'editor-child']) {
      expect(allowsNativeContextMenu(document.getElementById(id))).toBe(true)
    }
  })

  it('allows marked output text but excludes interactive descendants', () => {
    document.body.innerHTML = `
      <div data-native-context-menu="text">
        <p id="output">result</p>
        <button id="button" type="button">copy</button>
        <a id="link" href="#">source</a>
        <input id="task" type="checkbox">
      </div>
    `

    expect(allowsNativeContextMenu(document.getElementById('output'))).toBe(true)
    expect(allowsNativeContextMenu(document.getElementById('button'))).toBe(false)
    expect(allowsNativeContextMenu(document.getElementById('link'))).toBe(false)
    expect(allowsNativeContextMenu(document.getElementById('task'))).toBe(false)
  })

  it('lets application context-menu triggers handle the event', () => {
    document.body.innerHTML = '<div data-app-context-menu><span id="trigger">model</span></div>'
    const dispose = installNativeContextMenuPolicy()
    try {
      expect(rightClickIsAllowed(document.getElementById('trigger')!)).toBe(true)
    } finally {
      dispose()
    }
  })

  it('prevents native menus on ordinary interface components', () => {
    document.body.innerHTML = `
      <div id="panel">panel</div>
      <input id="checkbox" type="checkbox">
      <select id="select"><option>one</option></select>
    `
    const dispose = installNativeContextMenuPolicy()
    try {
      expect(rightClickIsAllowed(document.getElementById('panel')!)).toBe(false)
      expect(rightClickIsAllowed(document.getElementById('checkbox')!)).toBe(false)
      expect(rightClickIsAllowed(document.getElementById('select')!)).toBe(false)
    } finally {
      dispose()
    }
  })
})
