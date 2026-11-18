// The upstream half of a "the server commits, the answer is lost" intercept.
//
// `route.fetch()` runs in the Playwright DRIVER, over a keep-alive agent shared by every
// test in the run, not in the browser. A socket the server has just closed can be
// picked up there and fail with ECONNRESET before the request is ever answered. That
// is a fault of the test's own plumbing, and the native 3G step has no test retries
// (`--retries=0`), so one reset used to fail the whole run.
//
// This helper repeats the upstream fetch, and only that, when (and only when) it
// fails with ECONNRESET, at most ONCE per call. Everything else is untouched:
//   - any other error is rethrown at once, unretried;
//   - a second ECONNRESET is rethrown (the bound is one);
//   - every retry is counted by the caller and surfaced as a test annotation, so a
//     reset-then-replay is visible in the report and is never a silent pass.
// The caller keeps asserting that the final upstream response is ok, and the identity
// checks (one block, one submission, no duplicate claim) still catch a replay that
// created anything twice: the save carries the same idempotency key on both attempts.

export interface FetchableRoute<R> {
  fetch(): Promise<R>;
}

export interface UpstreamTally {
  /** Retries made by each upstream fetch, in order. Every entry must be 0 or 1. */
  retriesPerFetch: number[];
}

// A reset is recognised by its error CODE, or by Playwright's own message form for it: the
// first line is exactly "<api>: read ECONNRESET" (the call log follows on later lines). A
// message that merely MENTIONS the text, for example an application error, is not a reset.
const PLAYWRIGHT_RESET_LINE = /^(?:[\w.]+: )?read ECONNRESET$/;

export const isConnectionReset = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "ECONNRESET") return true;
  return typeof message === "string" && PLAYWRIGHT_RESET_LINE.test(message.split("\n")[0]!.trim());
};

export async function fetchUpstreamOnce<R>(route: FetchableRoute<R>, tally: UpstreamTally): Promise<R> {
  try {
    const response = await route.fetch();
    tally.retriesPerFetch.push(0);
    return response;
  } catch (error) {
    if (!isConnectionReset(error)) throw error;
  }
  // One retry of the same upstream request; a second failure of any kind propagates.
  const response = await route.fetch();
  tally.retriesPerFetch.push(1);
  return response;
}

export const totalRetries = (tally: UpstreamTally): number => tally.retriesPerFetch.reduce((a, b) => a + b, 0);
