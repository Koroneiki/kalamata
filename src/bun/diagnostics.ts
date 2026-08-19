import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_LOG_SIZE_BYTES = 1024 * 1024

interface SerializedDiagnosticError {
  name: string
  message: string
  stack?: string
  cause?: SerializedDiagnosticError
}

type ProcessFailure = { toString(): string } | null | undefined

type InfoDiagnostic =
  | {
      event: 'app.started'
      version: string
      platform: NodeJS.Platform
      architecture: string
    }
  | {
      event: 'app.ready' | 'app.shutdown-started' | 'app.shutdown-completed'
    }
  | {
      event: 'operation.state-changed'
      status: string
      phase?: string
      kind?: string
      appId?: number
      operationError?: { kind: string; message: string }
    }

type ErrorDiagnostic =
  | { event: 'depot-key-cache.initialization-failed'; error: Error }
  | { event: 'operation.failed'; error: Error; appId: number; kind: string }
  | { event: 'app.shutdown-failed'; error: Error }
  | { event: 'recovery.failed'; error: Error; appId: number }
  | {
      event: 'process.uncaught-exception'
      error: Error
      origin: NodeJS.UncaughtExceptionOrigin
    }
  | { event: 'process.unhandled-rejection'; error: Error }
  | {
      event: 'product-info.package-discovery-failed'
      error: Error
      appIds: number[]
      countryCode: string
    }

export class Diagnostics {
  readonly path: string
  private readonly archivePath: string

  constructor(userDataDirectory: string) {
    mkdirSync(userDataDirectory, { recursive: true })
    this.path = join(userDataDirectory, 'kalamata.log')
    this.archivePath = join(userDataDirectory, 'kalamata.old.log')
  }

  info(diagnostic: InfoDiagnostic): void {
    this.append(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        ...diagnostic,
      }),
    )
  }

  error(diagnostic: ErrorDiagnostic): void {
    try {
      this.append(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          ...diagnostic,
          level: 'error',
          error: serializeError(diagnostic.error),
        }),
      )
    } catch (error) {
      this.reportFailure(
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  private append(line: string): void {
    const entry = `${line}\n`
    this.rotateIfNeeded(Buffer.byteLength(entry))
    try {
      appendFileSync(this.path, entry)
    } catch (error) {
      this.reportFailure(
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  private rotateIfNeeded(entrySize: number): void {
    try {
      const current = statSync(this.path, { throwIfNoEntry: false })
      if (
        !current ||
        current.size === 0 ||
        current.size + entrySize <= MAX_LOG_SIZE_BYTES
      )
        return
      renameSync(this.path, this.archivePath)
    } catch (error) {
      this.reportFailure(
        error instanceof Error ? error : new Error(String(error)),
      )
    }
  }

  private reportFailure(error: Error): void {
    // Diagnostics must never prevent the application from running.
    console.error('Could not write Kalamata diagnostics', error)
  }
}

let applicationDiagnostics: Diagnostics | undefined

export function initializeApplicationDiagnostics(
  userDataDirectory: string,
): Diagnostics {
  const diagnostics = new Diagnostics(userDataDirectory)
  registerProcessDiagnostics(diagnostics)
  applicationDiagnostics = diagnostics
  return diagnostics
}

export function getApplicationDiagnostics(): Diagnostics {
  if (!applicationDiagnostics)
    throw new Error('Application diagnostics were not initialized')
  return applicationDiagnostics
}

export function registerProcessDiagnostics(
  diagnostics: Diagnostics,
): () => void {
  const handleUncaughtException = (
    error: ProcessFailure,
    origin: NodeJS.UncaughtExceptionOrigin,
  ) => {
    diagnostics.error({
      event: 'process.uncaught-exception',
      error: errorFromUnknown(error),
      origin,
    })
  }
  const handleUnhandledRejection = (reason: ProcessFailure) => {
    // Electrobun already owns rejection handling; mirror it to the durable log.
    diagnostics.error({
      event: 'process.unhandled-rejection',
      error: errorFromUnknown(reason),
    })
  }
  process.on('uncaughtExceptionMonitor', handleUncaughtException)
  process.on('unhandledRejection', handleUnhandledRejection)
  return () => {
    process.off('uncaughtExceptionMonitor', handleUncaughtException)
    process.off('unhandledRejection', handleUnhandledRejection)
  }
}

function errorFromUnknown(value: ProcessFailure): Error {
  if (value instanceof Error) return value
  try {
    return new Error(String(value))
  } catch {
    return new Error('Non-Error process failure could not be serialized')
  }
}

function serializeError(
  error: Error,
  seen = new Set<Error>(),
): SerializedDiagnosticError {
  if (seen.has(error))
    return { name: error.name, message: 'Circular error cause omitted' }
  seen.add(error)
  const serialized: SerializedDiagnosticError = {
    name: error.name,
    message: error.message,
  }
  if (error.stack) serialized.stack = error.stack
  if (error.cause instanceof Error)
    serialized.cause = serializeError(error.cause, seen)
  return serialized
}
