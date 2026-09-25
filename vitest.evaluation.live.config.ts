import { defineConfig } from 'vitest/config'
import base from './vitest.evaluation.config'

export default defineConfig({
  ...base,
  test: { ...base.test, include: ['src/evaluation/coding.live.ts'], testTimeout: 180_000 }
})
