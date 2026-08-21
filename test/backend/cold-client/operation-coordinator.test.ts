import { expect, test } from 'bun:test'
import { ColdClientMutationMutex } from '../../../src/backend/cold-client/mutation-mutex.ts'
import { ColdClientOperationCoordinator } from '../../../src/backend/cold-client/operation-coordinator.ts'
import type { ColdClientOperationSnapshot } from '../../../src/types/cold-client.ts'

test('admits one mutation and publishes complete phase snapshots', async () => {
  const snapshots: ColdClientOperationSnapshot[] = []
  const coordinator = new ColdClientOperationCoordinator(
    new ColdClientMutationMutex(),
    (snapshot) => snapshots.push(snapshot),
  )
  let release!: () => void
  let started!: () => void
  const operationStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const operation = coordinator.run('setup', 10, async (context) => {
    context.setPhase('building')
    started()
    await new Promise<void>((resolve) => {
      release = resolve
    })
    context.beginReplacement()
    context.setPhase('validating')
  })

  expect(() => coordinator.run('regenerate', 20, async () => {})).toThrow(
    'already running',
  )
  await operationStarted
  release()
  await operation

  expect(snapshots).toEqual([
    {
      status: 'active',
      appId: 10,
      kind: 'setup',
      phase: 'waiting-for-generator',
      cancellable: true,
    },
    {
      status: 'active',
      appId: 10,
      kind: 'setup',
      phase: 'building',
      cancellable: true,
    },
    {
      status: 'active',
      appId: 10,
      kind: 'setup',
      phase: 'replacing',
      cancellable: false,
    },
    {
      status: 'active',
      appId: 10,
      kind: 'setup',
      phase: 'validating',
      cancellable: false,
    },
    { status: 'idle' },
  ])
})

test('cancels before replacement and waits for shutdown cleanup', async () => {
  const coordinator = new ColdClientOperationCoordinator(
    new ColdClientMutationMutex(),
  )
  let cleanupFinished = false
  let started!: () => void
  const active = new Promise<void>((resolve) => {
    started = resolve
  })
  const operation = coordinator.run('regenerate', 10, async ({ signal }) => {
    started()
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true })
    })
    await Bun.sleep(1)
    cleanupFinished = true
    signal.throwIfAborted()
  })
  await active

  const shutdown = coordinator.shutdown()
  expect(cleanupFinished).toBe(false)
  await expect(operation).rejects.toThrow('shutting down')
  await shutdown

  expect(cleanupFinished).toBe(true)
  expect(coordinator.getSnapshot()).toEqual({ status: 'idle' })
  expect(() => coordinator.run('setup', 10, async () => {})).toThrow(
    'shutting down',
  )
})

test('does not cancel after replacement begins', async () => {
  const coordinator = new ColdClientOperationCoordinator(
    new ColdClientMutationMutex(),
  )
  let release!: () => void
  let replacing!: () => void
  const replacementStarted = new Promise<void>((resolve) => {
    replacing = resolve
  })
  const operation = coordinator.run('update-core', 10, async (context) => {
    context.beginReplacement()
    replacing()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await replacementStarted

  expect(coordinator.cancel(10)).toEqual({
    accepted: false,
    reason: 'replacement-in-progress',
  })
  const shutdown = coordinator.shutdown()
  release()
  await operation
  await shutdown
})

test('reports operation failures with app context', async () => {
  const failures: Array<{ error: Error; appId: number; kind: string }> = []
  const coordinator = new ColdClientOperationCoordinator(
    new ColdClientMutationMutex(),
    () => {},
    (error, context) => failures.push({ error, ...context }),
  )

  await expect(
    coordinator.run('update-core', 10, async () => {
      throw new Error('core failed')
    }),
  ).rejects.toThrow('core failed')

  expect(failures).toMatchObject([
    { error: { message: 'core failed' }, appId: 10, kind: 'update-core' },
  ])
})

test('does not retain an operation when its initial snapshot cannot be sent', async () => {
  let fail = true
  const coordinator = new ColdClientOperationCoordinator(
    new ColdClientMutationMutex(),
    () => {
      if (fail) throw new Error('transport closed')
    },
  )

  expect(() => coordinator.run('setup', 10, async () => {})).toThrow(
    'transport closed',
  )
  expect(coordinator.getSnapshot()).toEqual({ status: 'idle' })

  fail = false
  await expect(
    coordinator.run('setup', 10, async () => 'completed'),
  ).resolves.toBe('completed')
})
