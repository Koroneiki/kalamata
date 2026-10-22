interface DownloadServerGroup {
  key: string
  site: string | null
  urls: string[]
}

export function groupDownloadServers(
  urls: readonly string[],
): DownloadServerGroup[] {
  const groups = new Map<string, DownloadServerGroup>()
  for (const value of new Set(urls)) {
    const url = new URL(value)
    const site =
      /^cache\d+-([a-z0-9]+(?:-[a-z0-9]+)*)\.steamcontent\.com$/u.exec(
        url.hostname,
      )?.[1] ?? null
    // This is a display grouping, not a claim about physical clusters. Keep
    // different transports and ports separate, even when their site matches.
    const key = site
      ? `${url.protocol}//${site}.steamcontent.com:${url.port}`
      : value
    let group = groups.get(key)
    if (!group) {
      group = { key, site, urls: [] }
      groups.set(key, group)
    }
    group.urls.push(value)
  }
  // Cache hosts change between chunks; site order must not depend on which host appears first.
  return [...groups.values()].sort(
    (left, right) =>
      (left.site ?? left.key).localeCompare(right.site ?? right.key) ||
      left.key.localeCompare(right.key),
  )
}
