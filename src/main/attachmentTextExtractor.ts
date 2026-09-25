import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import { readFile } from 'node:fs/promises'

export interface ExtractedAttachmentText {
  text: string
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function supportsLocalTextExtraction(mimeType: string): boolean {
  return mimeType === 'application/pdf' ||
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
}

export async function extractLocalAttachmentText(filePath: string, mimeType: string): Promise<ExtractedAttachmentText> {
  const buffer = await readFile(filePath)
  if (mimeType === 'application/pdf') {
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      return { text: normalizeText(result.text) }
    } finally {
      await parser.destroy()
    }
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await mammoth.extractRawText({ buffer })
    return { text: normalizeText(result.value) }
  }
  throw new Error(`Unsupported local text extraction type: ${mimeType}`)
}
