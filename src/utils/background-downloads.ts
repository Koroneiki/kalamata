import type { BackgroundDownloadJob } from '@/types/background-downloads'

const labels: Record<BackgroundDownloadJob['kind'], string> = {
  'application-update': 'Application update',
  dependency: 'Dependency',
  manifest: 'Manifest',
  'depot-keys': 'Depot Keys',
}

export function backgroundDownloadLabel(job: BackgroundDownloadJob): string {
  const name = job.appId === null ? job.title : labels[job.kind]
  return job.source ? `${name} · ${job.source}` : name
}
