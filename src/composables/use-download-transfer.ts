import {
  computed,
  onScopeDispose,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue'

export interface DownloadTransfer {
  key: string
  bytes: string | number
  total: string | number | null
}

// A live chunk-download trace had healthy gaps of almost 4s between updates.
// Keep that gap plus one display tick as the inactivity and rate-smoothing horizon.
const RATE_HORIZON_MS = 5_000

export function useDownloadTransfer(
  source: MaybeRefOrGetter<DownloadTransfer | null>,
) {
  const bytesPerSecond = shallowRef<number | null>(null)
  let baseline: { bytes: bigint; time: number } | null = null

  watch(
    () => toValue(source),
    (transfer, previous) => {
      if (
        transfer &&
        previous &&
        transfer.key === previous.key &&
        BigInt(transfer.bytes) >= BigInt(previous.bytes)
      )
        return
      bytesPerSecond.value = null
      baseline = transfer
        ? { bytes: BigInt(transfer.bytes), time: performance.now() }
        : null
    },
    { immediate: true, flush: 'sync' },
  )

  const timer = setInterval(() => {
    const transfer = toValue(source)
    if (!transfer || !baseline) return
    const time = performance.now()
    const bytes = BigInt(transfer.bytes)
    const elapsed = time - baseline.time
    if (elapsed <= 0) return
    if (bytes === baseline.bytes) {
      // Chunk counters are silent while work is in flight. Include that time in
      // the next progress sample rather than feeding artificial zeros into it.
      if (elapsed >= RATE_HORIZON_MS || bytesPerSecond.value === 0) {
        bytesPerSecond.value = 0
        // Once stalled, keep a fresh baseline so recovery excludes the outage.
        baseline = { bytes, time }
      }
      return
    }
    const rate = (Number(bytes - baseline.bytes) * 1_000) / elapsed
    const previousRate = bytesPerSecond.value
    // Exponential weighting avoids the cliff when a burst leaves a rolling
    // window; elapsed-time weighting also handles irregular progress arrivals.
    const weight = -Math.expm1(-elapsed / RATE_HORIZON_MS)
    bytesPerSecond.value = previousRate
      ? previousRate + weight * (rate - previousRate)
      : rate
    baseline = { bytes, time }
  }, 1_000)
  onScopeDispose(() => clearInterval(timer))

  const remainingSeconds = computed(() => {
    const transfer = toValue(source)
    const speed = bytesPerSecond.value
    if (!transfer || transfer.total === null || !speed) return null
    const remaining = BigInt(transfer.total) - BigInt(transfer.bytes)
    return remaining > 0n ? Math.ceil(Number(remaining) / speed) : null
  })

  return { bytesPerSecond, remainingSeconds }
}
