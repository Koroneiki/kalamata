import type { ElectrobunConfig } from 'electrobun'
import packageJson from './package.json' with { type: 'json' }

export default {
  app: {
    name: 'Kalamata',
    identifier: 'dev.kalamata.app',
    version: packageJson.version,
  },
  build: {
    mac: {
      icons: 'assets/icon.iconset',
    },
    win: {
      icon: 'assets/icon.png',
    },
    linux: {
      icon: 'assets/icon.png',
    },
    bun: {
      entrypoint: 'src/bun/index.ts',
      // Bundling steam-crypto bakes its build-machine __dirname into the PEM lookup.
      external: ['@doctormckay/steam-crypto'],
    },
    copy: {
      'node_modules/@doctormckay/steam-crypto':
        'node_modules/@doctormckay/steam-crypto',
      // The bundled decompression worker resolves adm-zip at runtime.
      'node_modules/adm-zip': 'node_modules/adm-zip',
      // steam-user loads this fallback dynamically, so Bun cannot discover it.
      'node_modules/lzma': 'node_modules/lzma',
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
      'dist/decompress-worker': 'bun/decompress-worker',
      'src/db/migrations': 'bun/migrations',
    },
    watchIgnore: ['dist/**'],
  },
  scripts: {
    preBuild: './scripts/build-decompress-worker.ts',
    postWrap: './scripts/sign-macos-wrapper.ts',
  },
} satisfies ElectrobunConfig
