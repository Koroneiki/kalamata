import type { ElectrobunConfig } from 'electrobun'
import packageJson from './package.json' with { type: 'json' }

export default {
  app: {
    name: 'Kalamata',
    identifier: 'dev.kalamata.app',
    version: packageJson.version,
  },
  build: {
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    copy: {
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
      'dist/decompress-worker': 'bun/decompress-worker',
      'src/db/migrations': 'bun/migrations',
    },
    watchIgnore: ['dist/**'],
  },
  scripts: {
    preBuild: './scripts/build-decompress-worker.ts',
  },
} satisfies ElectrobunConfig
