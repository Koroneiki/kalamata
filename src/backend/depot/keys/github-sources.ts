export const GITHUB_REPOSITORIES = [
  'dvahana2424-web/sojogamesdatabase1',
  'hammerwebsite12/sojogames2',
] as const

export function githubAppFile(
  repo: string,
  appId: number,
  filename: string,
): string {
  return `https://raw.githubusercontent.com/${repo}/${appId}/${filename}`
}
