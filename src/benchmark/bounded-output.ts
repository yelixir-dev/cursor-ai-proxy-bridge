export const DEFAULT_OMO_STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_OMO_STDERR_LIMIT_BYTES = 1024 * 1024;

export class OutputByteCounter {
  readonly #limit: number;
  #observed = 0;

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new RangeError('output byte limit must be a positive safe integer');
    }
    this.#limit = limit;
  }

  accept(chunk: Buffer): boolean {
    if (chunk.byteLength > this.#limit - this.#observed) return false;
    this.#observed += chunk.byteLength;
    return true;
  }
}
