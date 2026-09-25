import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import { afterEach, describe, expect, it } from 'vitest'
import { extractLocalAttachmentText } from './attachmentTextExtractor'

const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const roots: string[] = []

async function filePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anas-docx-extraction-'))
  roots.push(root)
  return join(root, '中文 attachment.docx')
}

async function createDocx(path: string, document?: string): Promise<void> {
  const zip = new ZipFile()
  zip.addBuffer(Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), '[Content_Types].xml')
  zip.addBuffer(Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), '_rels/.rels')
  if (document !== undefined) zip.addBuffer(Buffer.from(document), 'word/document.xml')
  const complete = pipeline(zip.outputStream, createWriteStream(path, { flags: 'wx' }))
  zip.end()
  await complete
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('DOCX text extraction with the installed XML parser', () => {
  it('extracts namespaces, Chinese, XML entities and paragraphs through real mammoth', async () => {
    const path = await filePath()
    await createDocx(path, '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>中文 &amp; &lt;示例&gt;</w:t></w:r><w:r><w:t xml:space="preserve"> English</w:t></w:r></w:p><w:p/><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>')
    await expect(extractLocalAttachmentText(path, docxType)).resolves.toEqual({ text: '中文 & <示例> English\n\n第二段' })
  })

  it('reports a damaged archive instead of silently returning empty content', async () => {
    const path = await filePath()
    await writeFile(path, 'not a ZIP archive')
    await expect(extractLocalAttachmentText(path, docxType)).rejects.toThrow()
  })

  it('reports a missing Word document part', async () => {
    const path = await filePath()
    await createDocx(path)
    await expect(extractLocalAttachmentText(path, docxType)).rejects.toThrow()
  })
})
