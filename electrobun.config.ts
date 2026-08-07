import type { ElectrobunConfig } from 'electrobun'

export default {
  app: {
    name: 'Kalamata',
    identifier: 'dev.kalamata.app',
    version: '0.1.0',
  },
  build: {
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    copy: {
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
      'dist/decompress-worker': 'bun/decompress-worker',
    },
    watchIgnore: ['dist/**'],
  },
  scripts: {
    preBuild: './scripts/build-decompress-worker.ts',
  },
} satisfies ElectrobunConfig
