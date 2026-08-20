export class CursorBackendError extends Error {
  readonly name: string = 'CursorBackendError';
}

export class CursorCommandAbortedError extends Error {
  readonly name: string = 'AbortError';

  constructor(message = 'cursor command aborted') {
    super(message);
  }
}
