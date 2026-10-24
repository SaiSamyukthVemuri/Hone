// HON-46: the clinical-records export route, CANONICALLY. Isomorphic and
// dependency-free on purpose: next.config.ts (headers), instrumentation-client.ts
// (telemetry gate) and the tests all import THIS, so no consumer carries a
// hand-copied path that could drift (Codex P1 4303921817).

/** next.config `headers()` source for the export document. */
export const RECORDS_EXPORT_HEADER_SOURCE = "/clients/:id/records/export";

/** Matches the export document's pathname (no query, no hash). */
export const RECORDS_EXPORT_PATH_RE = /^\/clients\/[^/]+\/records\/export\/?$/;

/** True when `pathname` is the clinical-records export document. */
export function isRecordsExportPath(pathname: string): boolean {
  return RECORDS_EXPORT_PATH_RE.test(pathname);
}
