import { expect, mock, test } from 'bun:test'
import {
  downloadQueueSnapshotSchema,
  operationStateSchema,
  parseRpcRequest,
  rpcRequestSchemas,
  rpcResponseSchemas,
  validatedRpcHandlers,
} from '../src/types/rpc-schemas.ts'

test('defines request and response schemas for every RPC method', () => {
  expect(Object.keys(rpcRequestSchemas).sort()).toEqual(
    Object.keys(rpcResponseSchemas).sort(),
  )
})

test('validates complete download queue snapshots', () => {
  expect(
    downloadQueueSnapshotSchema.parse({
      operation: { status: 'idle' },
      repairRequiredAppIds: [20],
      pending: [
        {
          id: 'queue-item',
          appId: 10,
          kind: 'reconcile',
          installPath: '/games/example',
          desiredDepotIds: [],
          createdAt: 1,
        },
      ],
    }).pending,
  ).toHaveLength(1)
  expect(() =>
    downloadQueueSnapshotSchema.parse({
      operation: { status: 'idle' },
      repairRequiredAppIds: [],
      pending: [{ id: '', unexpected: true }],
    }),
  ).toThrow()
  expect(() =>
    downloadQueueSnapshotSchema.parse({
      operation: { status: 'idle' },
      repairRequiredAppIds: [20, 20],
      pending: [],
    }),
  ).toThrow()
})

test('validates RPC parameters before invoking a handler', () => {
  const getAppSummary = mock(() => ({
    appId: 10,
    name: 'Game',
    developers: [],
    publishers: [],
    releaseDate: null,
    iconUrls: [],
    artworkUrl: null,
  }))
  const handlers = validatedRpcHandlers({
    getAppSummary,
  } as unknown as Parameters<typeof validatedRpcHandlers>[0])

  expect(() => handlers.getAppSummary({ appId: 0 })).toThrow()
  expect(getAppSummary).not.toHaveBeenCalled()
})

test('rejects unknown fields and malformed operation states', () => {
  expect(() => parseRpcRequest('getLibrary', { unexpected: true })).toThrow()
  expect(
    operationStateSchema.safeParse({ status: 'active', appId: 10 }).success,
  ).toBe(false)
})
