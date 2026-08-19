import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface InterfaceProcessRunner {
  (
    executable: string,
    steamApiPath: string,
    workingDirectory: string,
    signal: AbortSignal,
  ): Promise<number>
}

export class ColdClientInterfaceGenerator {
  constructor(
    private readonly runProcess: InterfaceProcessRunner = defaultRunProcess,
  ) {}

  async generate(
    executable: string,
    steamApiPath: string,
    temporaryRoot: string,
    destination: string,
    signal: AbortSignal,
  ): Promise<void> {
    await mkdir(temporaryRoot, { recursive: true })
    const workingDirectory = await mkdtemp(join(temporaryRoot, 'interfaces-'))
    try {
      signal.throwIfAborted()
      const exitCode = await this.runProcess(
        executable,
        steamApiPath,
        workingDirectory,
        signal,
      )
      signal.throwIfAborted()
      if (exitCode !== 0) {
        throw new Error(`Interface generator exited with code ${exitCode}`)
      }
      const output = join(workingDirectory, 'steam_interfaces.txt')
      const metadata = await lstat(output)
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size === 0
      ) {
        throw new Error(
          'Interface generator did not create steam_interfaces.txt',
        )
      }
      await mkdir(dirname(destination), { recursive: true })
      await rename(output, destination)
    } finally {
      await rm(workingDirectory, { recursive: true, force: true })
    }
  }
}

async function defaultRunProcess(
  executable: string,
  steamApiPath: string,
  workingDirectory: string,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted()
  const subprocess = Bun.spawn([executable, steamApiPath], {
    cwd: workingDirectory,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
  })
  const abort = () => subprocess.kill()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const exitCode = await subprocess.exited
    signal.throwIfAborted()
    return exitCode
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
