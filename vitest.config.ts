import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    coverage: {
      include: [
        'src/main/agent/agentDatabase.ts',
        'src/main/agent/toolAuthorization.ts',
        'src/main/agent/toolEffectClassification.ts',
        'src/main/agent/toolEffectMiddleware.ts',
        'src/main/inputHistoryStore.ts',
        'src/main/pathContainment.ts'
      ],
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      thresholds: {
        branches: 75,
        functions: 90,
        lines: 85,
        statements: 80,
        'src/main/agent/agentDatabase.ts': {
          branches: 75,
          functions: 95,
          lines: 88,
          statements: 85
        },
        'src/main/agent/toolAuthorization.ts': {
          branches: 70,
          functions: 100,
          lines: 95,
          statements: 90
        },
        'src/main/agent/toolEffectClassification.ts': {
          branches: 85,
          functions: 100,
          lines: 95,
          statements: 90
        },
        'src/main/agent/toolEffectMiddleware.ts': {
          branches: 70,
          functions: 95,
          lines: 85,
          statements: 80
        },
        'src/main/inputHistoryStore.ts': {
          branches: 80,
          functions: 90,
          lines: 90,
          statements: 85
        },
        'src/main/pathContainment.ts': {
          branches: 80,
          functions: 100,
          lines: 100,
          statements: 85
        }
      }
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true
  }
})
