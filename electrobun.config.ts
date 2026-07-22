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
    },
    watchIgnore: ['dist/**'],
  },
} satisfies ElectrobunConfig
