import { expect, test } from 'bun:test'

import { operationCompletionMessage } from '../src/utils/operation.ts'

test('labels completed reconcile operations as updates', () => {
  expect(operationCompletionMessage('reconcile')).toBe('Finished updating')
})
