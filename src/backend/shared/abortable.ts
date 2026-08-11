export function abortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolvePromise, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise
      .then(resolvePromise, reject)
      .finally(() => signal.removeEventListener('abort', abort))
  })
}
