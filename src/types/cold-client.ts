import { z } from 'zod'

export const coldClientRelativePathSchema = z
  .string()
  .superRefine((value, ctx) => {
    const segments = value.split('/')
    if (
      value.length === 0 ||
      value.startsWith('/') ||
      value.includes('\\') ||
      value.includes(':') ||
      value.includes('\0') ||
      segments.some(
        (segment) => segment === '' || segment === '.' || segment === '..',
      )
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid relative path' })
    }
  })

export const managedCoreFilesSchema = z
  .array(coldClientRelativePathSchema)
  .min(1)
  .superRefine((paths, ctx) => {
    const seen = new Set<string>()
    paths.forEach((path, index) => {
      const key = path.toLowerCase()
      if (seen.has(key)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Managed core paths must be unique',
          path: [index],
        })
      }
      seen.add(key)
    })
  })

export const coldClientInstallationSchema = z
  .object({
    appId: z.number().int().positive().max(4_294_967_295),
    loaderArchitecture: z.enum(['x86', 'x64']),
    executableRelativePath: coldClientRelativePathSchema,
    steamApiRelativePath: coldClientRelativePathSchema.nullable(),
    launchArguments: z.string(),
    launchArgumentSource: z.string().min(1).nullable(),
    gbeAssetId: z.number().int().positive().safe(),
    gseAssetId: z.number().int().positive().safe(),
    generatedDepotFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    managedCoreFiles: managedCoreFilesSchema,
    configuredAt: z.number().int().nonnegative().safe(),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.loaderArchitecture === 'x86' && !record.steamApiRelativePath) {
      ctx.addIssue({
        code: 'custom',
        message: 'x86 installations require a Steam API DLL',
        path: ['steamApiRelativePath'],
      })
    }
  })

export type ColdClientInstallation = z.infer<
  typeof coldClientInstallationSchema
>

export const coldClientDependencyIds = ['7zip', 'gbe', 'gse'] as const
export type ColdClientDependencyId = (typeof coldClientDependencyIds)[number]
export const coldClientDependencyIdSchema = z.enum(coldClientDependencyIds)
export type ColdClientDependencyState =
  | 'current'
  | 'update-available'
  | 'missing'
  | 'check-failed'

export interface ColdClientDependencyItemStatus {
  dependencyId: ColdClientDependencyId
  status: ColdClientDependencyState
  currentAssetId: number | null
  currentTag: string | null
  availableAssetId: number | null
  availableTag: string | null
  error: string | null
}

export interface ColdClientDependencyStatus {
  supported: boolean
  dependencies: ColdClientDependencyItemStatus[]
  lastCheckedAt: number | null
  loginFileExists: boolean
  loginDirectory: string | null
}

export const coldClientLoaderArchitectureSchema = z.enum(['x86', 'x64'])
export type ColdClientLoaderArchitecture = z.infer<
  typeof coldClientLoaderArchitectureSchema
>

export const coldClientDetectionSourceSchema = z.enum([
  'shipping-executable',
  'sole-executable',
  'steam-launch',
  'manual-choice',
  'binary-directory',
  'sole-steam-api',
  'missing-dll-fallback',
])
export type ColdClientDetectionSource = z.infer<
  typeof coldClientDetectionSourceSchema
>

export const coldClientSetupWarningSchema = z.enum([
  'multiple-shipping-executables',
  'executable-choice-required',
  'steam-api-choice-required',
  'x64-assumed-without-steam-api',
  'launch-executable-mismatch',
  'existing-cold-client-will-be-replaced',
])
export type ColdClientSetupWarning = z.infer<
  typeof coldClientSetupWarningSchema
>

export interface ColdClientLaunchOption {
  key: string
  executable: string
  matchedExecutableRelativePath: string | null
  arguments: string
  description: string | null
}

export interface ColdClientSetupDependency {
  assetId: number
  tag: string
}

export interface ColdClientSetupDraft {
  appId: number
  targetRelativePath: '_ColdClient'
  executableCandidates: string[]
  selectedExecutableRelativePath: string | null
  executableDetectionSource: ColdClientDetectionSource
  steamApiCandidates: string[]
  selectedSteamApiRelativePath: string | null
  steamApiDetectionSource: ColdClientDetectionSource
  loaderArchitecture: ColdClientLoaderArchitecture
  launchOptions: ColdClientLaunchOption[]
  launchArguments: string
  launchArgumentSource: string | null
  warnings: ColdClientSetupWarning[]
  existingColdClient: boolean
  gbe: ColdClientSetupDependency
  gse: ColdClientSetupDependency
}
