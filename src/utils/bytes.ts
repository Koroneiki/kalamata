const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'] as const

export function formatBytes(value: string): string {
  const bytes = BigInt(value)
  let divisor = 1n
  let unit = 0

  while (unit < BYTE_UNITS.length - 1 && bytes >= divisor * 1024n) {
    divisor *= 1024n
    unit++
  }

  if (unit === 0) return `${bytes.toLocaleString()} B`

  const tenths = (bytes * 10n + divisor / 2n) / divisor
  const whole = tenths / 10n
  const fraction = tenths % 10n
  return `${whole.toLocaleString()}${fraction ? `.${fraction}` : ''} ${BYTE_UNITS[unit]}`
}

export function bytePercentage(downloaded: string, total: string): number {
  const totalBytes = BigInt(total)
  if (totalBytes === 0n) return 0

  const percentageTenths = (BigInt(downloaded) * 1000n) / totalBytes
  return Math.min(100, Number(percentageTenths) / 10)
}
