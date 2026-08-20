import { createHash } from 'node:crypto'
import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveExtractor } from '../../../src/backend/cold-client/archive-extractor.ts'
import { ColdClientDependencyService } from '../../../src/backend/cold-client/dependency-service.ts'
import { ColdClientMutationMutex } from '../../../src/backend/cold-client/mutation-mutex.ts'
import type { ColdClientDependencyId } from '../../../src/types/cold-client.ts'
import { removeTemporaryDirectory } from '../../helpers/filesystem.ts'

const gbeFiles = [
  'release/steamclient_experimental/ColdClientLoader.ini',
  'release/steamclient_experimental/GameOverlayRenderer.dll',
  'release/steamclient_experimental/GameOverlayRenderer64.dll',
  'release/steamclient_experimental/steamclient.dll',
  'release/steamclient_experimental/steamclient64.dll',
  'release/steamclient_experimental/steamclient_loader_x86.exe',
  'release/steamclient_experimental/steamclient_loader_x64.exe',
  'release/steamclient_experimental/extra_dlls/steamclient_extra_x86.dll',
  'release/steamclient_experimental/extra_dlls/steamclient_extra_x64.dll',
  'release/tools/generate_interfaces/generate_interfaces_x64.exe',
]
const gseFiles = [
  'generate_emu_config/generate_emu_config.exe',
  'generate_emu_config/_internal/python312.dll',
  'generate_emu_config/_DEFAULT/1/steam_settings/configs.overlay.ini',
]

let root: string | undefined

afterEach(async () => {
  if (root) await removeTemporaryDirectory(root)
  root = undefined
})

test('checks exact release assets without downloading them', async () => {
  const fixture = await createFixture()

  const status = await fixture.service.checkForUpdates()

  expect(fixture.downloads).toEqual([])
  expect(status.dependencies).toEqual([
    expect.objectContaining({
      dependencyId: '7zip',
      status: 'missing',
      availableAssetId: 101,
    }),
    expect.objectContaining({ dependencyId: 'gbe', status: 'missing' }),
    expect.objectContaining({ dependencyId: 'gse', status: 'missing' }),
  ])
})

test('bootstraps 7-Zip and preserves an active cache after digest failure', async () => {
  const fixture = await createFixture()
  await fixture.service.checkForUpdates()

  await fixture.service.updateDependencies(['gbe'])

  expect(fixture.downloads).toEqual([101, 201])
  expect(fixture.service.activeArtifact('7zip')?.assetId).toBe(101)
  expect(fixture.service.activeArtifact('gbe')?.assetId).toBe(201)

  fixture.setArtifact('gbe', 202, 'gbe-two', '0'.repeat(64))
  await fixture.service.checkForUpdates()
  await expect(fixture.service.updateDependencies(['gbe'])).rejects.toThrow(
    'digest does not match',
  )

  expect(fixture.service.activeArtifact('gbe')?.assetId).toBe(201)
  expect(
    await readFile(
      join(fixture.service.artifactDirectory('gbe', 201), gbeFiles[0]!),
      'utf8',
    ),
  ).toBe('fixture')
})

test('accepts inventory validation without a digest and copies login opaquely', async () => {
  const fixture = await createFixture()
  await fixture.service.checkForUpdates()
  await fixture.service.updateDependencies(['gse'])
  const login = Buffer.from([0, 255, 10, 42, 99])
  await writeFile(
    join(
      fixture.service.artifactDirectory('gse', 301),
      'generate_emu_config',
      'my_login.txt',
    ),
    login,
  )

  fixture.setArtifact('gse', 302, 'gse-two', null)
  await fixture.service.checkForUpdates()
  await fixture.service.updateDependencies(['gse'])

  expect(fixture.service.activeArtifact('gse')).toMatchObject({
    assetId: 302,
    verificationMode: 'https-inventory',
  })
  expect(
    await readFile(
      join(
        fixture.service.artifactDirectory('gse', 302),
        'generate_emu_config',
        'my_login.txt',
      ),
    ),
  ).toEqual(login)
})

test('keeps validated cached dependencies usable after a check failure', async () => {
  const fixture = await createFixture()
  await fixture.service.checkForUpdates()
  await fixture.service.updateDependencies(['gbe'])
  fixture.failChecks.add('gbe')

  const status = await fixture.service.checkForUpdates()

  expect(status.dependencies[1]).toMatchObject({
    dependencyId: 'gbe',
    status: 'check-failed',
    currentAssetId: 201,
  })
  expect(fixture.service.activeArtifact('gbe')?.assetId).toBe(201)
})

test('stops a selected dependency update after the first failure', async () => {
  const fixture = await createFixture()
  await fixture.service.checkForUpdates()
  await fixture.service.updateDependencies(['7zip'])
  fixture.setArtifact('gbe', 202, 'gbe-two', '0'.repeat(64))
  await fixture.service.checkForUpdates()
  const downloadsBefore = fixture.downloads.length

  await expect(
    fixture.service.updateDependencies(['gbe', 'gse']),
  ).rejects.toThrow('digest does not match')

  expect(fixture.downloads.slice(downloadsBefore)).toEqual([202])
  expect(fixture.service.activeArtifact('gse')).toBeNull()
})

test('shutdown cancels activation waiting for the mutation mutex', async () => {
  const mutex = new ColdClientMutationMutex()
  let releaseMutex!: () => void
  let mutexHeld!: () => void
  const held = new Promise<void>((resolve) => {
    mutexHeld = resolve
  })
  const blocker = mutex.runExclusive(async () => {
    mutexHeld()
    await new Promise<void>((resolve) => {
      releaseMutex = resolve
    })
  })
  await held
  const fixture = await createFixture(mutex)
  await fixture.service.checkForUpdates()

  const update = fixture.service.updateDependencies(['7zip'])
  while (fixture.downloads.length === 0) await Bun.sleep(1)
  const shutdown = fixture.service.shutdown()
  releaseMutex()

  await expect(update).rejects.toThrow('shutting down')
  await shutdown
  await blocker
  expect(fixture.service.activeArtifact('7zip')).toBeNull()
})

interface Fixture {
  service: ColdClientDependencyService
  downloads: number[]
  failChecks: Set<ColdClientDependencyId>
  setArtifact(
    dependencyId: ColdClientDependencyId,
    assetId: number,
    contents: string,
    digest: string | null,
  ): void
}

async function createFixture(
  mutex: ColdClientMutationMutex = new ColdClientMutationMutex(),
): Promise<Fixture> {
  root = await mkdtemp(join(tmpdir(), 'cold-client-dependencies-'))
  const artifacts = new Map<ColdClientDependencyId, TestArtifact>()
  const downloads: number[] = []
  const failChecks = new Set<ColdClientDependencyId>()
  const setArtifact = (
    dependencyId: ColdClientDependencyId,
    assetId: number,
    contents: string,
    digest: string | null = sha256(contents),
  ) => {
    artifacts.set(dependencyId, {
      dependencyId,
      assetId,
      contents,
      digest,
    })
  }
  setArtifact('7zip', 101, 'MZ7zip')
  setArtifact('gbe', 201, 'gbe-one')
  setArtifact('gse', 301, 'gse-one')

  const fetcher = async (input: string | URL | Request) => {
    const url = String(input)
    const checked = dependencyFromUrl(url)
    if (url.includes('/releases/latest')) {
      if (failChecks.has(checked)) return new Response('', { status: 503 })
      return Response.json(releaseFor(artifacts.get(checked)!))
    }
    const artifact = [...artifacts.values()].find(
      ({ assetId }) => url === `https://github.com/test/download/${assetId}`,
    )!
    downloads.push(artifact.assetId)
    return new Response(artifact.contents)
  }
  const extractor = new ArchiveExtractor(async (command) => {
    if (command[1] === 'l') {
      return {
        exitCode: 0,
        stdout:
          'archive metadata\n----------\nPath = payload/file\nAttributes = A\n',
      }
    }
    const destination = command.find((argument) => argument.startsWith('-o'))!
    const archive = await readFile(command.at(-1)!, 'utf8')
    for (const path of archive.startsWith('gse') ? gseFiles : gbeFiles) {
      const target = join(destination.slice(2), path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, 'fixture')
    }
    return { exitCode: 0, stdout: '' }
  })
  const service = new ColdClientDependencyService(root, {
    platform: 'win32',
    fetcher,
    extractor,
    mutex,
    now: () => 1000,
  })
  await service.initialize()
  return { service, downloads, failChecks, setArtifact }
}

interface TestArtifact {
  dependencyId: ColdClientDependencyId
  assetId: number
  contents: string
  digest: string | null
}

function releaseFor(artifact: TestArtifact) {
  const names: Record<ColdClientDependencyId, string> = {
    '7zip': '7zr.exe',
    gbe: 'emu-win-release.7z',
    gse: 'gen_emu_cfg-Windows-Release.7z',
  }
  return {
    id: artifact.assetId + 10_000,
    tag_name: `release-${artifact.assetId}`,
    published_at: '2026-08-19T12:00:00Z',
    draft: false,
    prerelease: false,
    assets: [
      {
        id: artifact.assetId,
        name: names[artifact.dependencyId],
        size: Buffer.byteLength(artifact.contents),
        digest: artifact.digest === null ? null : `sha256:${artifact.digest}`,
        browser_download_url: `https://github.com/test/download/${artifact.assetId}`,
      },
    ],
  }
}

function dependencyFromUrl(url: string): ColdClientDependencyId {
  if (url.includes('ip7z/7zip')) return '7zip'
  if (url.includes('Detanup01/gbe_fork')) return 'gbe'
  return 'gse'
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
