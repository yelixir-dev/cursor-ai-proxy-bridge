import { performance } from 'node:perf_hooks';

type CompletionRoute = 'direct' | 'litellm' | 'unknown';
type CompletionOutcome = 'success' | 'error' | 'abort' | 'rate_limited';

/** Per-process accumulators retain labels and counters, never individual requests. */
interface CompletionSeries {
  readonly model: string;
  readonly route: CompletionRoute;
  readonly stream: boolean;
  requests: number;
  in_flight: number;
  success: number;
  backend_error: number;
  aborted: number;
  rate_limited: number;
  elapsedTotal: number;
  elapsedMaximum: number;
}

export class CompletionMetrics {
  private readonly models = new Set<string>();
  private readonly series = new Map<string, CompletionSeries>();
  private readonly startedAt = new Date().toISOString();

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly modelLimit = 128,
  ) {}

  start(
    model: string,
    suppliedRoute: string | string[] | undefined,
    stream: boolean,
  ): (outcome: CompletionOutcome) => void {
    const route =
      suppliedRoute === 'direct' || suppliedRoute === 'litellm' ? suppliedRoute : 'unknown';
    if (!this.models.has(model) && this.models.size < this.modelLimit) {
      this.models.add(model);
    }
    const label = this.models.has(model) ? model : '__other__';
    const key = JSON.stringify([label, route, stream]);
    let series = this.series.get(key);
    if (!series) {
      series = {
        model: label,
        route,
        stream,
        requests: 0,
        in_flight: 0,
        success: 0,
        backend_error: 0,
        aborted: 0,
        rate_limited: 0,
        elapsedTotal: 0,
        elapsedMaximum: 0,
      };
      this.series.set(key, series);
    }
    const counters = series;
    const startedAt = this.now();
    counters.requests += 1;
    counters.in_flight += 1;
    let finished = false;
    return (outcome) => {
      if (finished) return;
      finished = true;
      counters.in_flight -= 1;
      const elapsed = Math.max(0, this.now() - startedAt);
      counters.elapsedTotal += elapsed;
      counters.elapsedMaximum = Math.max(counters.elapsedMaximum, elapsed);
      switch (outcome) {
        case 'success':
          counters.success += 1;
          break;
        case 'error':
          counters.backend_error += 1;
          break;
        case 'abort':
          counters.aborted += 1;
          break;
        case 'rate_limited':
          counters.rate_limited += 1;
          break;
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    };
  }

  snapshot() {
    return {
      since: this.startedAt,
      model_limit: this.modelLimit,
      tracked_models: this.models.size,
      series: [...this.series.values()].map((series) => {
        const count = series.requests - series.in_flight;
        return {
          model: series.model,
          route: series.route,
          stream: series.stream,
          requests: series.requests,
          in_flight: series.in_flight,
          success: series.success,
          backend_error: series.backend_error,
          aborted: series.aborted,
          rate_limited: series.rate_limited,
          latency_ms: {
            count,
            total: series.elapsedTotal,
            maximum: series.elapsedMaximum,
            average: count === 0 ? 0 : series.elapsedTotal / count,
          },
        };
      }),
    };
  }
}
