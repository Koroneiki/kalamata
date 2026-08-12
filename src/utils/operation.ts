import type { OperationKind } from '../types/rpc.ts'

export function operationCompletionMessage(kind: OperationKind): string {
  if (kind === 'download') return 'Finished downloading'
  if (kind === 'reconcile') return 'Finished updating'
  return 'Files have been verified'
}
