import { describe, expect, test } from 'bun:test'

import { formatBytes } from '../src/utils/bytes'

describe('formatBytes', () => {
  test('formats scaled byte values with two decimal places', () => {
    expect(formatBytes('1024')).toBe('1.00 KiB')
    expect(formatBytes('1536')).toBe('1.50 KiB')
    expect(formatBytes('1295')).toBe('1.26 KiB')
    expect(formatBytes('1048576')).toBe('1.00 MiB')
    expect(formatBytes('1073741824')).toBe('1.00 GiB')
  })

  test('keeps byte values unscaled', () => {
    expect(formatBytes('512')).toBe('512 B')
  })
})
