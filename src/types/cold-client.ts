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
