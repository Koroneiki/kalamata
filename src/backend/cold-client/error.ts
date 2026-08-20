import { z } from 'zod'

export function asError<ErrorValue>(error: ErrorValue): Error {
  const result = z.instanceof(Error).safeParse(error)
  return result.success ? result.data : new Error(String(error))
}
