import type { OperationKind } from '../types/rpc.ts'

export function operationCompletionMessage(
  kind: OperationKind,
  desiredDepotIds: number[],
): string {
  if (kind === 'download') return 'Finished installing'
  if (kind === 'reconcile' && desiredDepotIds.length === 0)
    return 'Finished uninstalling'
  if (kind === 'reconcile') return 'Finished updating'
  return 'Files have been verified'
}
