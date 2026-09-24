import type { BackgroundDownloadJob } from '@/types/background-downloads'

const labels: Record<BackgroundDownloadJob['kind'], string> = {
  'application-update': 'Application update',
  dependency: 'Dependency',
  manifest: 'Manifest',
  'depot-keys': 'Depot Keys',
  'cold-client': 'ColdClient',
}

export function backgroundDownloadLabel(job: BackgroundDownloadJob): string {
  const name = backgroundDownloadName(job)
  return job.source ? `${name} · ${job.source}` : name
}

function backgroundDownloadName(job: BackgroundDownloadJob): string {
  if (job.kind === 'cold-client') return job.title
  if (job.kind === 'manifest' && job.itemCount !== undefined)
    return manifestCountLabel(job.itemCount)
  return job.appId === null ? job.title : labels[job.kind]
}

function manifestCountLabel(count: number): string {
  return `${count} manifest${count === 1 ? '' : 's'}`
}
