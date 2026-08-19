import { initializeApplicationDiagnostics } from './diagnostics.ts'

const { Utils } = await import('electrobun/bun')
initializeApplicationDiagnostics(Utils.paths.userData)

await import('./application.ts')
