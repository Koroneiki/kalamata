import { expect, test } from 'bun:test'

import { operationCompletionMessage } from '../src/utils/operation.ts'

test('labels completed downloads as installs', () => {
  expect(operationCompletionMessage('download', [228980])).toBe(
    'Finished installing',
  )
})

test('labels completed reconcile operations as updates', () => {
  expect(operationCompletionMessage('reconcile', [228986])).toBe(
    'Finished updating',
  )
})

test('labels completed reconcile operations without depots as uninstalls', () => {
  expect(operationCompletionMessage('reconcile', [])).toBe(
    'Finished uninstalling',
  )
})
