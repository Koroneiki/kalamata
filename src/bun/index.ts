import { initializeApplicationDiagnostics } from './diagnostics.ts'

const { Utils } = await import('electrobun/main')
initializeApplicationDiagnostics(Utils.paths.userData)

await import('./application.ts')
