import { expect, mock, test } from 'bun:test'
import {
  availableUpdateResultSchema,
  downloadQueueSnapshotSchema,
  hubcapUsageSchema,
  operationStateSchema,
  parseRpcRequest,
  rpcResponseSchemas,
  validatedRpcHandlers,
} from '../src/types/rpc-schemas.ts'

test('validates ColdClient dependency requests and secret-free status', () => {
  expect(
    parseRpcRequest('updateColdClientDependencies', {
      dependencyIds: ['gbe', 'gse'],
    }),
  ).toEqual({ dependencyIds: ['gbe', 'gse'] })
  expect(() =>
    parseRpcRequest('updateColdClientDependencies', {
      dependencyIds: ['gbe', 'gbe'],
    }),
  ).toThrow()
  expect(() =>
    parseRpcRequest('updateColdClientDependencies', {
      dependencyIds: ['unknown'],
    }),
  ).toThrow()

  const status = {
    supported: true,
    dependencies: (['7zip', 'gbe', 'gse'] as const).map((dependencyId) => ({
      dependencyId,
      status: 'missing' as const,
      currentAssetId: null,
      currentTag: null,
      availableAssetId: null,
      availableTag: null,
      error: null,
    })),
    lastCheckedAt: null,
    loginFileExists: false,
    loginDirectory:
      'C:/user-data/coldclient/dependencies/gse/1/generate_emu_config',
  }
  expect(rpcResponseSchemas.getColdClientDependencies.parse(status)).toEqual(
    status,
  )
  expect(() =>
    rpcResponseSchemas.getColdClientDependencies.parse({
      ...status,
      loginContents: 'secret',
    }),
  ).toThrow()
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

test('validates estimated download progress as a nullable decimal string', () => {
  const active = {
    status: 'active' as const,
    kind: 'download' as const,
    phase: 'downloading' as const,
    appId: 10,
    installPath: '/games/10',
    desiredDepotIds: [20],
    installedBytesCompleted: '5',
    installedBytesTotal: '10',
    reusedLocalBytes: '0',
    networkBytes: '3',
    estimatedDownloadBytes: '7',
  }

  expect(operationStateSchema.safeParse(active).success).toBe(true)
  expect(
    operationStateSchema.safeParse({
      ...active,
      estimatedDownloadBytes: null,
    }).success,
  ).toBe(true)
  expect(
    operationStateSchema.safeParse({
      ...active,
      estimatedDownloadBytes: 7,
    }).success,
  ).toBe(false)
})

test('validates priority queue requests', () => {
  expect(
    parseRpcRequest('prioritizeQueuedOperation', { id: 'queued' }),
  ).toEqual({ id: 'queued' })
  expect(
    parseRpcRequest('queueDepotUpdate', {
      appId: 10,
      desiredDepotIds: [20],
      priority: true,
    }),
  ).toMatchObject({ priority: true })
  expect(() =>
    parseRpcRequest('prioritizeQueuedOperation', { id: '' }),
  ).toThrow()
})

test('validates Hubcap requests, usage, and acquisition outcomes', () => {
  const usage = {
    dailyUsage: 90,
    dailyLimit: 100,
    remaining: 10,
    canMakeRequests: true,
  }
  expect(
    parseRpcRequest('acquireDepotKeys', {
      appId: 10,
      depotIds: [20],
      approveLowQuotaHubcap: true,
    }).approveLowQuotaHubcap,
  ).toBe(true)
  expect(() =>
    parseRpcRequest('acquireDepotKeys', {
      appId: 10,
      depotIds: [20],
      approveLowQuotaHubcap: 'yes',
    }),
  ).toThrow()
  expect(hubcapUsageSchema.parse(usage)).toEqual(usage)
  expect(() => hubcapUsageSchema.parse({ ...usage, remaining: 9 })).toThrow()

  const outcomes = [
    { status: 'approval-required', usage },
    { status: 'fetched', usage, acquiredDepotIds: [20] },
    { status: 'missing-key' },
    { status: 'invalid-key' },
    { status: 'quota-exhausted', usage },
    { status: 'stats-unavailable' },
  ]
  for (const hubcap of outcomes) {
    expect(
      rpcResponseSchemas.acquireDepotKeys.safeParse({
        acquiredDepotIds: [],
        missingDepotIds: [20],
        hubcap,
      }).success,
    ).toBe(true)
  }
  expect(
    rpcResponseSchemas.getHubcapUsage.safeParse({
      status: 'available',
      usage,
    }).success,
  ).toBe(true)
  for (const status of ['missing-key', 'invalid-key', 'stats-unavailable']) {
    expect(
      rpcResponseSchemas.getHubcapUsage.safeParse({ status }).success,
    ).toBe(true)
  }
  expect(
    rpcResponseSchemas.getHubcapUsage.safeParse({
      status: 'invalid-key',
      extra: true,
    }).success,
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
