const result = await Bun.build({
  entrypoints: ['src/backend/depot/decompress-worker.ts'],
  outdir: 'dist/decompress-worker',
  target: 'bun',
})

if (!result.success)
  throw new AggregateError(result.logs, 'Worker build failed')
