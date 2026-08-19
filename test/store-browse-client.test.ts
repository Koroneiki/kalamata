import { expect, mock, test } from 'bun:test'
import { StoreBrowseClient } from '../src/backend/steam/store-browse-client.ts'

test('rejects HTTP failures', async () => {
  const client = new StoreBrowseClient(
    mock(
      async (_input: string | URL | Request) =>
        new Response(null, { status: 503 }),
    ),
  )

  await expect(client.getPackageIds([440])).rejects.toThrow('HTTP 503')
})
