import { EventEmitter } from 'node:events';
import { bounded } from './processes.mjs';

export function lifecycleMonitor() {
  const bus = new EventEmitter();
  const entries = [];
  let cancellation = null;
  const active = new Set();
  const key = (event) => `${event.conn}:${event.stream}`;
  return {
    entries,
    record(event) {
      entries.push(event);
      if (event.event === 'open' && event.detail.path === '/agent.v1.AgentService/Run')
        active.add(key(event));
      if (event.event === 'close') active.delete(key(event));
      bus.emit('change');
    },
    cancel() {
      cancellation = { targets: [...active], index: entries.length };
    },
    async waitForCancelledClose(signal) {
      if (!cancellation?.targets.length) return false;
      const check = () =>
        cancellation.targets.every((target) =>
          ['close', 'upstream_close'].every((kind) =>
            entries
              .slice(cancellation.index)
              .some((event) => key(event) === target && event.event === kind),
          ),
        );
      if (check()) return true;
      let listener;
      const observed = new Promise((resolve) => {
        listener = () => {
          if (check()) resolve(true);
        };
        bus.on('change', listener);
      });
      try {
        return await bounded(observed, 10000, 'upstream_close_timeout', signal);
      } finally {
        bus.off('change', listener);
      }
    },
  };
}
