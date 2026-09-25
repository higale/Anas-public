const textInputTypes = new Set([
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url'
])

const interactiveSelector = [
  'a',
  'button',
  'canvas',
  'img',
  'input',
  'select',
  'summary',
  'svg',
  'video',
  'audio',
  '[role="button"]',
  '[role="menuitem"]',
  '[role="option"]'
].join(',')

function isTextEditingControl(element: Element): boolean {
  const input = element.closest('input')
  if (input) return textInputTypes.has(input.type.toLowerCase())
  if (element.closest('textarea')) return true
  const contentEditable = element.closest('[contenteditable]')
  return Boolean(contentEditable && contentEditable.getAttribute('contenteditable') !== 'false')
}

export function allowsNativeContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (isTextEditingControl(target)) return true
  if (target.closest('[data-app-context-menu]')) return true
  if (target.closest(interactiveSelector)) return false
  return Boolean(target.closest('[data-native-context-menu="text"]'))
}

export function installNativeContextMenuPolicy(): () => void {
  const handleContextMenu = (event: MouseEvent): void => {
    if (!allowsNativeContextMenu(event.target)) event.preventDefault()
  }
  document.addEventListener('contextmenu', handleContextMenu, true)
  return () => document.removeEventListener('contextmenu', handleContextMenu, true)
}
