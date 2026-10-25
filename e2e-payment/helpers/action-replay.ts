import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

// HON-44. A browser that is NOT offered a control can still be handed a request:
// the owner's own prepare action, replayed by a practitioner. This captures a real
// Server Action POST made by the owner's UI and replays it, byte for byte, from
// another signed-in context, so "the action refuses a non-owner" is proved against
// the real action and the real database, not a hand-built imitation of Next's wire
// format. The replay is only meaningful with a POSITIVE CONTROL (the same replay by
// the owner must create a row), which the spec supplies.

export type CapturedAction = {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
};

// Headers that identify the action and shape its body. Cookies are NOT copied: the
// replaying context supplies its own, which is the point.
const KEEP = ["next-action", "content-type", "accept", "next-router-state-tree", "next-url"];

/** Start recording every Server Action POST this page makes. */
export function captureActionPosts(page: Page): CapturedAction[] {
  const captured: CapturedAction[] = [];
  page.on("request", (req) => {
    if (req.method() !== "POST") return;
    const headers = req.headers();
    if (!headers["next-action"]) return;
    captured.push({
      url: req.url(),
      headers: Object.fromEntries(KEEP.filter((k) => headers[k] !== undefined).map((k) => [k, headers[k]!])),
      body: req.postDataBuffer() ?? Buffer.alloc(0),
    });
  });
  return captured;
}

/**
 * Replay a captured action from `request` (a context with its own cookies). `swap`
 * rewrites ids in the URL and body; ids are same-length UUIDs, so a multipart body
 * keeps a valid length and boundary.
 */
export function replayAction(
  request: APIRequestContext,
  action: CapturedAction,
  swap: ReadonlyArray<readonly [from: string, to: string]> = [],
): Promise<APIResponse> {
  const rewrite = (text: string) => swap.reduce((acc, [from, to]) => acc.split(from).join(to), text);
  const url = rewrite(action.url);
  return request.post(url, {
    // A browser sends these on a same-origin Server Action POST and Next checks
    // them (CSRF); an API request does not unless told.
    headers: { ...action.headers, origin: new URL(url).origin, referer: url },
    data: Buffer.from(rewrite(action.body.toString("utf8")), "utf8"),
  });
}
