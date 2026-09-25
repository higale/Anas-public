import { createSummarizationMiddleware, StateBackend, type BackendRuntime } from 'deepagents'
import { projectRulesSchema } from './projectRules'

// LangChain exposes only declared state fields to each middleware. Reuse the
// framework's summary schema so context readers see the checkpoint boundary.
const summarizationStateSchema = createSummarizationMiddleware({
  backend: (runtime: BackendRuntime) => new StateBackend(runtime)
}).stateSchema!

export const agentContextStateSchema = summarizationStateSchema.extend({
  anasProjectRules: projectRulesSchema.optional()
})
