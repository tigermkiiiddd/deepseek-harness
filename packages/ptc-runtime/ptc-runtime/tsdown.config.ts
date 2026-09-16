import { defineConfig } from 'tsdown'

/** Build the package root and companion bundles as independent outputs. */
export default defineConfig([
  {
    'entry': [
      'lib/types/index.js'
    ],
    'outDir': 'lib',
    'format': [
      'esm'
    ],
    'platform': 'node',
    'target': 'es2024',
    'fixedExtension': false,
    'dts': false,
    'clean': false
  }
])
