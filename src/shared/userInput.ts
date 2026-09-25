import { z } from 'zod/v3'

export const userInputSchema = z.object({
  questions: z.array(z.object({
    id: z.string().trim().min(1).max(80).describe('Unique question ID for matching the answer.'),
    question: z.string().trim().min(1).max(2_000),
    options: z.array(z.object({
      label: z.string().trim().min(1).max(200),
      description: z.string().max(500).optional()
    })).max(12).superRefine((options, context) => {
      const labels = new Set<string>()
      options.forEach((option, index) => {
        if (labels.has(option.label)) context.addIssue({ code: z.ZodIssueCode.custom,
          path: [index, 'label'], message: 'Option labels within each question must be unique.' })
        labels.add(option.label)
      })
    }).describe('Suggested choices in display order, with unique labels within each question. Use an empty array for free text. The UI always provides Other input.'),
    multiple: z.boolean().optional().describe('Allow selecting multiple options. Default false.')
  })).min(1).max(5).superRefine((questions, context) => {
    const ids = new Set<string>()
    questions.forEach((question, index) => {
      if (ids.has(question.id)) context.addIssue({ code: z.ZodIssueCode.custom,
        path: [index, 'id'], message: 'Question IDs must be unique.' })
      ids.add(question.id)
    })
  }),
  require_response: z.boolean().optional().describe('Default false. True disables the answer timeout; use cautiously, only when work cannot continue without the answer. The user can still cancel.'),
  timeout_seconds: z.number().int().min(30).max(600).optional().describe('Default 60 seconds after the dialog is shown. User interaction cancels the timeout. Ignored when require_response is true.')
})

export const userInputResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('cancelled') }).strict(),
  z.object({ status: z.literal('answered'), answers: z.array(z.object({
    question_id: z.string().min(1).max(80),
    selected_options: z.array(z.string().max(200)).max(12),
    other: z.string().trim().max(8_000)
  }).strict()).min(1).max(5) }).strict()
])

export type UserInput = z.infer<typeof userInputSchema>
export type UserInputResponse = z.infer<typeof userInputResponseSchema>
export type UserInputResult = UserInputResponse | { status: 'timed_out' }
export interface UserInputSource {
  projectName: string
  threadTitle: string
  agentName?: string
}
export interface UserInputRequest {
  id: string
  threadId: string
  runId: string
  source: UserInputSource
  questions: UserInput['questions']
  requireResponse: boolean
  interacted: boolean
  timeoutSeconds: number
  deadline?: number
}
export interface UserInputSnapshot { revision: number; requests: UserInputRequest[] }
export interface UserInputApi {
  list(): Promise<UserInputSnapshot>
  shown(id: string): Promise<boolean>
  interact(id: string): Promise<boolean>
  respond(id: string, response: UserInputResponse): Promise<boolean>
  onChange(listener: (snapshot: UserInputSnapshot) => void): () => void
}
