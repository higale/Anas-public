import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => {
  const productionBuild = command === 'build'
  return {
    main: {
      define: {
        __ANAS_BUILD_ENVIRONMENT__: JSON.stringify(productionBuild ? 'production' : 'development'),
        __ANAS_BUILD_TIME__: JSON.stringify(productionBuild ? new Date().toISOString() : '')
      },
      plugins: [externalizeDepsPlugin()],
      build: {
        rollupOptions: {
          output: { interop: 'auto' },
          input: {
            index: resolve('src/main/index.ts'),
            packagedSmoke: resolve('src/main/packagedSmoke.ts')
          }
        }
      },
      resolve: {
        alias: {
          '@shared': resolve('src/shared')
        }
      }
    },
    preload: {
      plugins: [externalizeDepsPlugin()],
      resolve: {
        alias: {
          '@shared': resolve('src/shared')
        }
      }
    },
    renderer: {
      root: 'src/renderer',
      server: {
        host: '127.0.0.1',
        port: 15173,
        strictPort: true
      },
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@monaco/codicon.css': resolve('node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css'),
          '@shared': resolve('src/shared')
        }
      },
      plugins: [react()]
    }
  }
})
