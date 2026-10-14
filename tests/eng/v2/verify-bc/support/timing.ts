// Hook timing: when VBC_TIMING_LOG names a file, each wrapped hook appends { label, ms } to it, so a run under load
// can report its slowest hooks. Without the variable it only runs the hook.

import fs from "node:fs";

export function timed<T>(label: string, fn: () => T | Promise<T>): () => Promise<T> {
  return async () => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      const log = process.env.VBC_TIMING_LOG;
      if (log) fs.appendFileSync(log, JSON.stringify({ label, ms: Date.now() - t0 }) + "\n");
    }
  };
}
