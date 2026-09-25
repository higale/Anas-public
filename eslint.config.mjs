import js from '@eslint/js'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'node_modules/**',
      'out/**',
      'release-build/**',
      'release-macos/**',
      'release-portable/**'
    ]
  },
  {
    files: ['**/*.{cjs,mjs,js}'],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.node
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommended
    ],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }]
    }
  },
  {
    files: ['src/renderer/**/*.tsx'],
    ...jsxA11y.flatConfigs.recommended,
    languageOptions: {
      ...jsxA11y.flatConfigs.recommended.languageOptions,
      globals: {
        ...globals.browser,
        ...globals.node
      },
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
        tsconfigRootDir: import.meta.dirname
      }
    },
    plugins: {
      ...jsxA11y.flatConfigs.recommended.plugins,
      'react-hooks': reactHooks
    },
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      'jsx-a11y/label-has-associated-control': ['error', {
        controlComponents: ['Checkbox', 'CommitTextarea', 'CommitTextInput'],
        depth: 4
      }],
      'jsx-a11y/no-autofocus': 'off',
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/rules-of-hooks': 'error'
    },
    settings: {
      'jsx-a11y': {
        components: {
          Checkbox: 'input',
          CommitTextarea: 'textarea',
          CommitTextInput: 'input'
        }
      }
    }
  }
)
