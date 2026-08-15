import { ApplicationTransactionError } from '../depot/install/transaction/types.ts'
import type { OperationErrorKind, OperationState } from '../../types/rpc.ts'
import { uniqueSteamIdsSchema } from '../../types/schemas.ts'

interface SerializedOperationError {
  kind: OperationErrorKind
  message: string
}

export function validateDepotIds(
  depotIds: number[],
  allowEmpty: boolean,
): void {
  if (!allowEmpty && depotIds.length === 0)
    throw new Error('Select at least one depot')
  uniqueSteamIdsSchema.parse(depotIds)
}

export function operationError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error('Unknown operation failure')
}

export function serializeOperationError(
  error: Error,
): SerializedOperationError {
  const kind =
    error instanceof ApplicationTransactionError ? error.kind : 'planning'
  const messages = {
    planning: 'The installation plan is invalid.',
    'unavailable-resource': 'A required manifest or depot key is unavailable.',
    'insufficient-space':
      'There is not enough temporary disk space for the installation.',
    steam: 'Could not reach Steam, or Steam denied the request.',
    'unavailable-content': 'Required depot content is unavailable.',
    'transfer-exhausted': 'All eligible content servers failed.',
    integrity: 'Downloaded or staged content failed integrity verification.',
    filesystem: 'The installation filesystem operation failed.',
    cancellation: 'The operation stopped after a cancellation request.',
    recovery: 'Could not safely recover the interrupted installation.',
    persistence: 'Could not finalize the installation metadata.',
  } satisfies Record<OperationErrorKind, string>
  return { kind, message: messages[kind] }
}

export function isOperationCancellation(error: Error): boolean {
  return (
    (error instanceof ApplicationTransactionError &&
      error.kind === 'cancellation') ||
    (error instanceof Error && error.name === 'AbortError')
  )
}

export function isOperationShutdown(
  error: Error,
  signal: AbortSignal,
): boolean {
  return (
    signal.aborted &&
    signal.reason instanceof Error &&
    signal.reason.name === 'ShutdownError' &&
    (error instanceof ApplicationTransactionError
      ? error.kind === 'cancellation'
      : error === signal.reason)
  )
}

export function isRecoverableOperationError(kind: OperationErrorKind): boolean {
  return [
    'unavailable-resource',
    'insufficient-space',
    'steam',
    'unavailable-content',
    'transfer-exhausted',
    'integrity',
    'filesystem',
  ].includes(kind)
}

export function repairRequiredState(
  appId: number,
  installPath: string,
): OperationState {
  return {
    status: 'repair-required',
    appId,
    installPath,
    error: {
      kind: 'recovery',
      message:
        'The interrupted installation cannot be verified. Repair the game files before continuing.',
    },
  }
}
