export class ColdClientMutationMutex {
  #tail = Promise.resolve()

  async runExclusive<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const previous = this.#tail
    let release!: () => void
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }
}
