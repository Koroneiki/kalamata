import { createHash } from 'node:crypto'

export interface InstalledDepotIdentity {
  depotId: number
  installedManifestId: string
}

export function coldClientDepotFingerprint(
  installs: InstalledDepotIdentity[],
): string {
  const source = installs
    .toSorted((left, right) => left.depotId - right.depotId)
    .map(
      ({ depotId, installedManifestId }) =>
        `${depotId}:${installedManifestId}\n`,
    )
    .join('')
  return createHash('sha256').update(source, 'utf8').digest('hex')
}
