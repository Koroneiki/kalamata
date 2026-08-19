import { z } from 'zod'
import {
  type ColdClientDependencyId,
  coldClientDependencyIds,
  coldClientDependencyIdSchema,
} from '../../types/cold-client.ts'

const positiveSafeIntegerSchema = z.number().int().positive().safe()
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const httpsUrlSchema = z
  .url()
  .refine((value) => new URL(value).protocol === 'https:')
const githubDownloadUrlSchema = httpsUrlSchema.refine(
  (value) => new URL(value).hostname === 'github.com',
)

const githubAssetSchema = z.object({
  id: positiveSafeIntegerSchema,
  name: z.string().min(1),
  size: positiveSafeIntegerSchema,
  digest: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .nullable(),
  browser_download_url: githubDownloadUrlSchema,
})

export const githubReleaseSchema = z.object({
  id: positiveSafeIntegerSchema,
  tag_name: z.string().min(1),
  published_at: z.iso.datetime(),
  draft: z.literal(false),
  prerelease: z.literal(false),
  assets: z.array(githubAssetSchema),
})
export type GithubRelease = z.infer<typeof githubReleaseSchema>

export const artifactDescriptorSchema = z
  .object({
    dependencyId: coldClientDependencyIdSchema,
    repository: z.string().min(1),
    assetId: positiveSafeIntegerSchema,
    releaseId: positiveSafeIntegerSchema,
    tag: z.string().min(1),
    publishedAt: z.iso.datetime(),
    assetName: z.string().min(1),
    sourceUrl: httpsUrlSchema,
    sha256: sha256Schema,
    verificationMode: z.enum(['github-digest', 'https-inventory']),
    validatedAt: z.number().int().nonnegative().safe(),
  })
  .strict()

export type ArtifactDescriptor = z.infer<typeof artifactDescriptorSchema>

export const dependencyMetadataSchema = z
  .object({
    version: z.literal(1),
    active: z
      .object({
        '7zip': positiveSafeIntegerSchema.nullable(),
        gbe: positiveSafeIntegerSchema.nullable(),
        gse: positiveSafeIntegerSchema.nullable(),
      })
      .strict(),
    artifacts: z.array(artifactDescriptorSchema),
  })
  .strict()
  .superRefine((metadata, ctx) => {
    const identities = new Set<string>()
    metadata.artifacts.forEach((artifact, index) => {
      const identity = `${artifact.dependencyId}:${artifact.assetId}`
      if (identities.has(identity)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Artifact identities must be unique',
          path: ['artifacts', index],
        })
      }
      identities.add(identity)
    })
    for (const dependencyId of coldClientDependencyIds) {
      const activeId = metadata.active[dependencyId]
      if (
        activeId !== null &&
        !metadata.artifacts.some(
          (artifact) =>
            artifact.dependencyId === dependencyId &&
            artifact.assetId === activeId,
        )
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Active artifact descriptor is missing',
          path: ['active', dependencyId],
        })
      }
    }
  })

export type DependencyMetadata = z.infer<typeof dependencyMetadataSchema>

export const emptyDependencyMetadata = (): DependencyMetadata => ({
  version: 1,
  active: { '7zip': null, gbe: null, gse: null },
  artifacts: [],
})

export interface RemoteArtifact {
  dependencyId: ColdClientDependencyId
  repository: string
  assetId: number
  releaseId: number
  tag: string
  publishedAt: string
  assetName: string
  sourceUrl: string
  expectedSize: number
  digest: string | null
}

export function parseRemoteArtifact(
  dependencyId: ColdClientDependencyId,
  repository: string,
  assetName: string,
  release: GithubRelease,
): RemoteArtifact {
  const assets = release.assets.filter((asset) => asset.name === assetName)
  if (assets.length !== 1) {
    throw new Error(`Release must contain exactly one ${assetName} asset`)
  }
  const asset = assets[0]!
  return {
    dependencyId,
    repository,
    assetId: asset.id,
    releaseId: release.id,
    tag: release.tag_name,
    publishedAt: release.published_at,
    assetName: asset.name,
    sourceUrl: asset.browser_download_url,
    expectedSize: asset.size,
    digest: asset.digest?.slice('sha256:'.length) ?? null,
  }
}
