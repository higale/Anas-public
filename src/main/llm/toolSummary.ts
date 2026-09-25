import { z } from 'zod/v3'

export const toolSummarySchema = z.string().trim().min(1).optional().describe(
  'Brief UI summary of this action, 5-10 words, in the user\'s language.'
)
