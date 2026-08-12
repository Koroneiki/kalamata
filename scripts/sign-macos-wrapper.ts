if (process.platform !== 'darwin') process.exit(0)

const appPath = process.env.ELECTROBUN_WRAPPER_BUNDLE_PATH

if (!appPath) throw new Error('ELECTROBUN_WRAPPER_BUNDLE_PATH is required')

const result = Bun.spawnSync(
  ['codesign', '--force', '--deep', '--sign', '-', appPath],
  {
    stderr: 'inherit',
    stdout: 'inherit',
  },
)

if (result.exitCode !== 0) {
  throw new Error(`Ad-hoc signing failed with exit code ${result.exitCode}`)
}
