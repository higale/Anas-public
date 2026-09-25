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
    environment: 'jsdom',
    include: ['src/**/*.dom.test.tsx'],
    setupFiles: ['src/renderer/src/test/setupDom.ts'],
    restoreMocks: true,
    clearMocks: true
  }
})
