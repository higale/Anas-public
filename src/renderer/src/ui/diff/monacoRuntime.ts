import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/basic-languages/monaco.contribution.js'
import '@monaco/codicon.css'
import { jsonDefaults } from 'monaco-editor/languages/features/json/register.js'
import EditorWorker from 'monaco-editor/editor/editor.worker?worker'

// Only tokenization and diff computation are needed. No editing language services.
jsonDefaults.setModeConfiguration({ tokens: true })
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
export { monaco }
export function languageForPath(path: string): string {
  const name = path.split(/[/\\]/).pop() ?? path
  return monaco.languages.getLanguages().find((language) => language.filenames?.includes(name)
    || language.extensions?.some((extension) => name.toLowerCase().endsWith(extension)))?.id ?? 'plaintext'
}
