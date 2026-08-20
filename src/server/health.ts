import type { BackendHealth, CursorBackend } from '../backend/types.js';

export class BackendHealthCache {
  private cached: { readonly value: BackendHealth; readonly expiresAt: number } | undefined;
  private refresh: Promise<BackendHealth> | undefined;

  constructor(private readonly backend: CursorBackend) {}

  async get(): Promise<BackendHealth> {
    if (this.cached && this.cached.expiresAt > Date.now()) return this.cached.value;
    if (!this.refresh) {
      this.refresh = this.backend
        .health()
        .then((value) => {
          this.cached = {
            value,
            expiresAt: Date.now() + (this.backend.type === 'auto' ? 0 : 10_000),
          };
          return value;
        })
        .finally(() => {
          this.refresh = undefined;
        });
    }
    return this.refresh;
  }

  invalidate(): void {
    this.cached = undefined;
  }
}
