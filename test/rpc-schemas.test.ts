import { expect, mock, test } from 'bun:test'
import {
  availableUpdateResultSchema,
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

test('validates every available update result variant and decimal data', () => {
  expect(
    availableUpdateResultSchema.parse({
      status: 'current',
      appId: 10,
      checkedAt: 1,
    }).status,
  ).toBe('current')
  expect(
    availableUpdateResultSchema.parse({
      status: 'error',
      appId: 10,
      message: 'Unavailable',
      checkedAt: 2,
    }).status,
  ).toBe('error')
  expect(
    availableUpdateResultSchema.parse({
      status: 'available',
      checkedAt: 3,
      candidate: {
        app: {
          appId: 10,
          name: 'Example',
          developers: [],
          publishers: [],
          releaseDate: null,
          iconUrls: [],
          artworkUrl: null,
        },
        installedDepotIds: [20],
        outdatedDepots: [
          {
            depotId: 20,
            ownerAppId: 10,
            installedManifestId: '9007199254740993',
            targetManifestId: '9007199254740994',
            sizeBytes: null,
            downloadBytes: '9007199254740995',
          },
        ],
        totalDownloadBytes: '9007199254740995',
      },
    }).status,
  ).toBe('available')
  expect(() =>
    availableUpdateResultSchema.parse({
      status: 'current',
      appId: 10,
      checkedAt: 1,
      unexpected: true,
    }),
  ).toThrow()
})
