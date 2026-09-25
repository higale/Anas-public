import { defineCodingSuite } from './codingSuite'

const configDirectory = process.env.ANAS_EVAL_CONFIG_DIR
if (!configDirectory) throw new Error('Set ANAS_EVAL_CONFIG_DIR to an explicitly authorized test config directory.')
await defineCodingSuite({
  kind: 'provider-runtime', configDirectory,
  modelId: process.env.ANAS_EVAL_MODEL_ID,
  repeats: process.env.ANAS_EVAL_REPEATS ? Number(process.env.ANAS_EVAL_REPEATS) : 1
})
