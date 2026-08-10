const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'] as const

export function formatBytes(value: string): string {
  const bytes = BigInt(value)
  let divisor = 1n
  let unit = 0

  while (unit < BYTE_UNITS.length - 1 && bytes >= divisor * 1024n) {
    divisor *= 1024n
    unit++
  }

  if (unit === 0) return `${bytes.toLocaleString()} B`

  const hundredths = (bytes * 100n + divisor / 2n) / divisor
  const whole = hundredths / 100n
  const fraction = (hundredths % 100n).toString().padStart(2, '0')
  return `${whole.toLocaleString()}.${fraction} ${BYTE_UNITS[unit]}`
}

export function bytePercentage(downloaded: string, total: string): number {
  const totalBytes = BigInt(total)
  if (totalBytes === 0n) return 0

  const percentageTenths = (BigInt(downloaded) * 1000n) / totalBytes
  return Math.min(100, Number(percentageTenths) / 10)
}
