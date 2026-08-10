import { describe, expect, test } from 'bun:test'

import { formatBytes } from '../src/utils/bytes'

describe('formatBytes', () => {
  test('formats scaled byte values with two decimal places', () => {
    expect(formatBytes('1024')).toBe('1.00 KB')
    expect(formatBytes('1536')).toBe('1.50 KB')
    expect(formatBytes('1295')).toBe('1.26 KB')
  })

  test('keeps byte values unscaled', () => {
    expect(formatBytes('512')).toBe('512 B')
  })
})
