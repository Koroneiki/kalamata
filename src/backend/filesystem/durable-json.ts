import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writeDurableJson<Value>(
  path: string,
  value: Value,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  await mkdir(dirname(path), { recursive: true })
  const contents = `${JSON.stringify(value, null, 2)}\n`
  try {
    const handle = await open(temporary, 'wx')
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    // Windows cannot reliably open directories for fsync. The file is still
    // flushed above; sync the directory entry where the OS supports it.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(path), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await rm(temporary, { force: true })
  }
}
