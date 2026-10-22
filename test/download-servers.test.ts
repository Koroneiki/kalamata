import { expect, test } from 'bun:test'

import { groupDownloadServers } from '../src/utils/download-servers.ts'

test('groups Steam cache numbers under their shared site and retains every unique active URL', () => {
  const first = 'https://cache1-fra1.steamcontent.com'
  const second = 'https://cache12-fra1.steamcontent.com'
  const groups = groupDownloadServers([first, second, first])
  expect(groups).toHaveLength(1)
  expect(groups[0]).toMatchObject({ site: 'fra1', urls: [first, second] })
  expect(groupDownloadServers([second])[0]).toMatchObject({
    site: 'fra1',
    urls: [second],
  })
  expect(groupDownloadServers([])).toEqual([])
})

test('keeps different sites, schemes and ports separate', () => {
  const urls = [
    'https://cache1-fra1.steamcontent.com',
    'https://cache2-fra2.steamcontent.com',
    'http://cache3-fra1.steamcontent.com',
    'https://cache4-fra1.steamcontent.com:8443',
  ]
  const groups = groupDownloadServers(urls)
  expect(groups.map((group) => group.urls)).toEqual(
    expect.arrayContaining(urls.map((url) => [url])),
  )
  expect(new Set(groups.map((group) => group.key)).size).toBe(urls.length)
})

test('preserves hyphenated site names while leaving other hostname formats unchanged', () => {
  const first = 'https://cache1-mel-aubb.steamcontent.com'
  const second = 'https://cache2-mel-aubb.steamcontent.com'
  const unrecognized = [
    'https://cdn.example.com',
    'https://cache1-fra1.steamcontent.com.example.com',
    'https://cache-fra1.steamcontent.com',
    'https://google.cdn.steampipe.steamcontent.com',
  ]
  const groups = groupDownloadServers([first, second, ...unrecognized])
  expect(groups.find((group) => group.site === 'mel-aubb')).toMatchObject({
    site: 'mel-aubb',
    urls: [first, second],
  })
  expect(groups.filter((group) => group.site === null)).toEqual(
    expect.arrayContaining(
      unrecognized.map((url) => ({ key: url, site: null, urls: [url] })),
    ),
  )
  expect(groups).toHaveLength(unrecognized.length + 1)
})

test('keeps sites alphabetically ordered as active cache hosts change', () => {
  const first = groupDownloadServers([
    'https://cache1-fra2.steamcontent.com',
    'https://cache9-fra1.steamcontent.com',
    'https://cache3-ams1.steamcontent.com',
  ])
  const next = groupDownloadServers([
    'https://cache1-ams1.steamcontent.com',
    'https://cache2-fra1.steamcontent.com',
    'https://cache8-fra2.steamcontent.com',
  ])
  expect(first.map((group) => group.site)).toEqual(['ams1', 'fra1', 'fra2'])
  expect(next.map((group) => group.key)).toEqual(
    first.map((group) => group.key),
  )
})
