import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { effectScope, shallowRef } from 'vue'
import {
  useDownloadTransfer,
  type DownloadTransfer,
} from '../src/composables/use-download-transfer.ts'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  mock.restore()
})

function measurement(initial: DownloadTransfer | null) {
  let now = 0
  let tick = () => {}
  spyOn(performance, 'now').mockImplementation(() => now)
  spyOn(globalThis, 'setInterval').mockImplementation(((
    handler: () => void,
  ) => {
    tick = handler
    return 0
  }) as typeof setInterval)
  spyOn(globalThis, 'clearInterval').mockImplementation(() => {
    tick = () => {}
  })
  const transfer = shallowRef(initial)
  const scope = effectScope()
  scopes.push(scope)
  const stats = scope.run(() => useDownloadTransfer(transfer))!
  return {
    transfer,
    ...stats,
    stop: () => scope.stop(),
    advance(milliseconds = 1_000) {
      now += milliseconds
      tick()
    },
  }
}

function download(bytes: string | number = 0, key = 'first'): DownloadTransfer {
  return { key, bytes, total: 10_000_000 }
}

test('measures only newly transferred bytes over actual elapsed time', () => {
  const stats = measurement(download('9007199254740993'))
  expect(stats.bytesPerSecond.value).toBeNull()
  stats.transfer.value = {
    ...download('9007199256740993'),
    total: '9007199264740993',
  }
  stats.advance(2_000)
  expect(stats.bytesPerSecond.value).toBe(1_000_000)
  expect(stats.remainingSeconds.value).toBe(8)
})

test('unknown sizes still show throughput, but never an ETA', () => {
  const stats = measurement({ ...download(), total: null })
  stats.transfer.value = { ...download(2_000_000), total: null }
  stats.advance()
  expect(stats.bytesPerSecond.value).toBe(2_000_000)
  expect(stats.remainingSeconds.value).toBeNull()
})

test('one quiet interval keeps the estimate, but sustained inactivity clears it', () => {
  const stats = measurement(download())
  stats.transfer.value = download(2_000_000)
  stats.advance()
  expect(stats.remainingSeconds.value).toBe(4)
  stats.advance()
  expect(stats.bytesPerSecond.value).toBe(2_000_000)
  expect(stats.remainingSeconds.value).toBe(4)
  stats.advance(4_000)
  expect(stats.bytesPerSecond.value).toBe(0)
  expect(stats.remainingSeconds.value).toBeNull()
  stats.advance(60_000)
  stats.transfer.value = download(4_000_000)
  stats.advance()
  expect(stats.bytesPerSecond.value).toBe(2_000_000)
  expect(stats.remainingSeconds.value).toBe(3)
})

test('bursty chunk completions do not alternate between a rate and zero', () => {
  const stats = measurement(download())
  stats.advance()
  stats.transfer.value = download(2_000_000)
  stats.advance()
  expect(stats.bytesPerSecond.value).toBe(1_000_000)
  expect(stats.remainingSeconds.value).toBe(8)
  stats.advance()
  expect(stats.bytesPerSecond.value).toBeGreaterThan(0)
  expect(stats.remainingSeconds.value).not.toBeNull()
  stats.transfer.value = download(4_000_000)
  stats.advance()
  expect(stats.bytesPerSecond.value).toBeGreaterThan(0)
  expect(stats.remainingSeconds.value).not.toBeNull()
})

test('unequal sampling intervals are weighted by elapsed time', () => {
  const stats = measurement(download())
  stats.transfer.value = download(1_000_000)
  stats.advance(500)
  expect(stats.bytesPerSecond.value).toBe(2_000_000)
  stats.transfer.value = download(4_000_000)
  stats.advance(1_500)
  expect(stats.bytesPerSecond.value).toBe(2_000_000)
  expect(stats.remainingSeconds.value).toBe(3)
})

test('sustained slowdowns replace the old rate rather than keeping a lifetime average', () => {
  const total = 100_000_000
  const stats = measurement({ ...download(), total })
  for (let second = 1; second <= 5; second++) {
    stats.transfer.value = { ...download(second * 2_000_000), total }
    stats.advance()
  }
  expect(stats.bytesPerSecond.value).toBe(2_000_000)
  expect(stats.remainingSeconds.value).toBe(45)

  stats.transfer.value = { ...download(11_000_000), total }
  stats.advance()
  expect(stats.bytesPerSecond.value).toBeLessThan(2_000_000)
  expect(stats.bytesPerSecond.value).toBeGreaterThan(1_000_000)
  for (let second = 2; second <= 5; second++) {
    stats.transfer.value = {
      ...download(10_000_000 + second * 1_000_000),
      total,
    }
    stats.advance()
  }
  const lifetimeAverage = 15_000_000 / 10
  expect(stats.bytesPerSecond.value).toBeLessThan(lifetimeAverage)
  expect(stats.bytesPerSecond.value).toBeGreaterThan(1_000_000)
  expect(stats.remainingSeconds.value).toBeGreaterThan(45)
})

test('a burst fades gradually instead of dropping out of a rolling window', () => {
  const total = 100_000_000
  const stats = measurement({ ...download(), total })
  stats.transfer.value = { ...download(1_000_000), total }
  stats.advance()
  stats.transfer.value = { ...download(11_000_000), total }
  stats.advance()
  let previousRate = stats.bytesPerSecond.value!
  let previousDrop = Infinity
  for (let bytes = 12_000_000; bytes <= 17_000_000; bytes += 1_000_000) {
    stats.transfer.value = { ...download(bytes), total }
    stats.advance()
    const rate = stats.bytesPerSecond.value!
    expect(rate).toBeGreaterThan(1_000_000)
    expect(rate).toBeLessThan(previousRate)
    expect(previousRate - rate).toBeLessThan(previousDrop)
    previousDrop = previousRate - rate
    previousRate = rate
  }
})

test('pausing clears measurements and resuming excludes the pause', () => {
  const stats = measurement(download())
  stats.transfer.value = download(2_000_000)
  stats.advance()
  stats.transfer.value = null
  expect(stats.bytesPerSecond.value).toBeNull()
  expect(stats.remainingSeconds.value).toBeNull()
  stats.advance(60_000)
  stats.transfer.value = download(2_000_000)
  expect(stats.bytesPerSecond.value).toBeNull()
  stats.transfer.value = download(4_000_000)
  stats.advance()
  expect(stats.bytesPerSecond.value).toBe(2_000_000)
  expect(stats.remainingSeconds.value).toBe(3)
})

test('changing downloads or resetting counters discards the old measurement', () => {
  const stats = measurement(download())
  stats.transfer.value = download(2_000_000)
  stats.advance()
  stats.transfer.value = download(5_000_000, 'second')
  expect(stats.bytesPerSecond.value).toBeNull()
  stats.transfer.value = download(6_000_000, 'second')
  stats.advance()
  expect(stats.bytesPerSecond.value).toBe(1_000_000)
  stats.transfer.value = download(0, 'second')
  expect(stats.bytesPerSecond.value).toBeNull()
  stats.transfer.value = download(2_000_000, 'second')
  stats.advance()
  expect(stats.bytesPerSecond.value).toBe(2_000_000)
})

test('completed or lowered estimates do not produce a negative ETA', () => {
  const stats = measurement(download())
  stats.transfer.value = download(2_000_000)
  stats.advance()
  stats.transfer.value = { ...download(2_000_000), total: 1_000_000 }
  expect(stats.remainingSeconds.value).toBeNull()
})

test('disposing the measurement owner stops sampling', () => {
  const stats = measurement(download())
  stats.transfer.value = download(2_000_000)
  stats.advance()
  stats.stop()
  stats.advance()
  expect(stats.bytesPerSecond.value).toBe(2_000_000)
})
