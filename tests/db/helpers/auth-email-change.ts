import { E2E_MAILPIT_URL, E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../../e2e/helpers/local-env";
import { listMessageIds, waitForMagicLink } from "../../../e2e/helpers/mail";
import { adminQuery } from "./harness";

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const auth = async (method: string, path: string, body: unknown, key: string, bearer?: string) => {
  const r = await fetch(`${E2E_SUPABASE_URL}/auth/v1/${path}`, {
    method, headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
};

/**
 * True when this stack does NOT auto-confirm email (hosted shape): a password sign-up returns no session. The Confirm-OFF files
 * skip themselves then; they describe the other config. Creates one throwaway synthetic user.
 */
export async function confirmationsAreOn(): Promise<boolean> {
  const r = await auth("POST", "signup", { email: `cfg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@harness.local`, password: `Pw-${Math.random()}-x1Y2z3` }, ANON);
  return typeof r.body.access_token !== "string";
}

/**
 * Applies an email change the way a mailbox owner would, so it works for BOTH `double_confirm_changes` settings and with email
 * confirmations ON or OFF: request the change with the user's own session, then follow every verify link GoTrue MAILS (one to the
 * new address; one more to the current address when double confirm is on). Falls back to admin-generated tokens only if the mailed
 * links did not complete the change. Returns which path completed it, for the evidence.
 */
export async function applyEmailChange(accessToken: string, userId: string, from: string, to: string): Promise<"mailed-links" | "admin-tokens" | "not-applied"> {
  const seenFrom = await listMessageIds(from);
  const seenTo = await listMessageIds(to);
  const put = await auth("PUT", "user", { email: to }, ANON, accessToken);
  if (put.status !== 200) throw new Error(`email change request refused: ${put.status}`);
  const follow = async (addr: string, seen: string[]) => {
    try {
      const link = await waitForMagicLink(addr, "http://localhost:3000", { excludeIds: seen, timeoutMs: 6000 });
      await fetch(link, { redirect: "manual" });
    } catch { /* no mail to this address: expected when double confirm is off for the current address */ }
  };
  await follow(to, seenTo);
  await follow(from, seenFrom);
  const changed = async () => (await adminQuery(`select email from auth.users where id = $1`, [userId])).rows[0]?.email === to;
  if (await changed()) return "mailed-links";
  for (const type of ["email_change_new", "email_change_current"]) {
    const l = await auth("POST", "admin/generate_link", { type, email: from, new_email: to }, E2E_SERVICE_ROLE_KEY);
    if (l.status === 200) await auth("POST", "verify", { type: "email_change", token_hash: l.body.hashed_token as string }, ANON);
  }
  return (await changed()) ? "admin-tokens" : "not-applied";
}

export type StackAuthConfig = { mailerAutoconfirm: boolean | null; doubleConfirm: boolean | null };
let cached: Promise<StackAuthConfig> | null = null;
/**
 * The stack's effective auth settings, READ not assumed. `mailer_autoconfirm` comes from GET /auth/v1/settings. GoTrue does not
 * publish `double_confirm_changes`, so it is MEASURED: request an email change for a throwaway user and see whether a mail also
 * reaches the CURRENT address (double confirm on) or only the new one. null = could not be determined.
 */
export function stackAuthConfig(): Promise<StackAuthConfig> {
  cached ??= (async () => {
    const settings = await auth("GET", "settings", undefined, ANON);
    const mailerAutoconfirm = typeof settings.body.mailer_autoconfirm === "boolean" ? settings.body.mailer_autoconfirm : null;
    let doubleConfirm: boolean | null = null;
    try {
      const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const from = `cfgdc-${tag}@harness.local`, to = `cfgdc-new-${tag}@harness.local`;
      await auth("POST", "admin/users", { email: from, email_confirm: true }, E2E_SERVICE_ROLE_KEY);
      const l = await auth("POST", "admin/generate_link", { type: "magiclink", email: from }, E2E_SERVICE_ROLE_KEY);
      const s = await auth("POST", "verify", { type: "magiclink", token_hash: l.body.hashed_token as string }, ANON);
      const seenFrom = await listMessageIds(from);
      await auth("PUT", "user", { email: to }, ANON, s.body.access_token as string);
      try { await waitForMagicLink(from, "http://localhost:3000", { excludeIds: seenFrom, timeoutMs: 5000 }); doubleConfirm = true; }
      catch { doubleConfirm = false; }
    } catch { /* leave null */ }
    return { mailerAutoconfirm, doubleConfirm };
  })();
  return cached;
}

/** The newest verify link mailed to `to` that is not in `seen`, polling Mailpit every 25 ms (fast enough to stay inside a second). */
export async function fastVerifyLink(to: string, seen: string[], timeoutMs = 8000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await fetch(`${E2E_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((r) => r.json() as Promise<{ messages?: { ID: string }[] }>);
    const m = (list.messages ?? []).find((x) => !seen.includes(x.ID));
    if (m) {
      const full = await fetch(`${E2E_MAILPIT_URL}/api/v1/message/${m.ID}`).then((r) => r.json() as Promise<{ Text?: string; HTML?: string }>);
      const hit = `${full.Text ?? ""}\n${full.HTML ?? ""}`.match(/https?:\/\/[^\s"'<>\])]+verify[^\s"'<>\])]*/);
      if (hit) return hit[0].replaceAll("&amp;", "&");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

export type CompletedChange = {
  applied: boolean;
  /** the session GoTrue returned to the click that COMPLETED the change (implicit: in the redirect fragment; PKCE: exchanged) */
  completionToken: string | null;
  completionRefreshToken: string | null;
  /** which mailbox's link completed it: "new" (the victim's) or "current" (the old address, the attacker's) */
  completedBy: "new" | "current" | null;
  links: { new: boolean; current: boolean };
};

/**
 * Applies an email change by the MAILED links in a chosen order and KEEPS the session the completing click returns (the earlier
 * helper threw it away, which is how that session went untested). `lastHalf: "current"` = the old address's link is clicked last
 * (the attacker-last order; with double_confirm off there is no such link and the new address's click completes it).
 */
export async function changeEmailKeepingCompletion(
  accessToken: string, userId: string, from: string, to: string,
  opts: { lastHalf: "new" | "current"; pkce?: { challenge: string; verifier: string } },
): Promise<CompletedChange> {
  const seenFrom = await listMessageIds(from);
  const seenTo = await listMessageIds(to);
  const body: Record<string, unknown> = { email: to };
  if (opts.pkce) { body.code_challenge = opts.pkce.challenge; body.code_challenge_method = "s256"; }
  const put = await auth("PUT", "user", body, ANON, accessToken);
  if (put.status !== 200) throw new Error(`email change request refused: ${put.status}`);
  const linkNew = await fastVerifyLink(to, seenTo);
  // The old address is mailed only when double confirm is on (MEASURED per stack, never assumed). Waiting for a mail that cannot
  // come would push the change ~1.5 s after the request and make a same-second case unreachable.
  const { doubleConfirm } = await stackAuthConfig();
  const linkCurrent = doubleConfirm === false ? null : await fastVerifyLink(from, seenFrom, doubleConfirm === true ? 8000 : 1500);
  const order: ["new" | "current", string | null][] = opts.lastHalf === "current" ? [["new", linkNew], ["current", linkCurrent]] : [["current", linkCurrent], ["new", linkNew]];
  let completionToken: string | null = null;
  let completionRefreshToken: string | null = null;
  let completedBy: CompletedChange["completedBy"] = null;
  for (const [half, link] of order) {
    if (!link) continue;
    const r = await fetch(link, { redirect: "manual" });
    const loc = new URL(r.headers.get("location") ?? "", "http://x");
    const frag = new URLSearchParams(loc.hash.slice(1));
    let token = frag.get("access_token");
    let rt = frag.get("refresh_token");
    const code = loc.searchParams.get("code");
    if (!token && code && opts.pkce) {
      const ex = await auth("POST", "token?grant_type=pkce", { auth_code: code, code_verifier: opts.pkce.verifier }, ANON);
      token = typeof ex.body.access_token === "string" ? ex.body.access_token : null;
      rt = typeof ex.body.refresh_token === "string" ? ex.body.refresh_token : null;
    }
    if (token) { completionToken = token; completionRefreshToken = rt; completedBy = half; }
  }
  const applied = (await adminQuery(`select email from auth.users where id = $1`, [userId])).rows[0]?.email === to;
  return { applied, completionToken, completionRefreshToken, completedBy, links: { new: !!linkNew, current: !!linkCurrent } };
}

/** The verify link of one `type` (magiclink, email_change, ...) mailed to `to` and not among `seen`; polled every 50 ms. */
export async function linkOfType(to: string, seen: string[], type: string, timeoutMs = 8000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await fetch(`${E2E_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((r) => r.json() as Promise<{ messages?: { ID: string }[] }>);
    for (const m of (list.messages ?? []).filter((x) => !seen.includes(x.ID))) {
      const full = await fetch(`${E2E_MAILPIT_URL}/api/v1/message/${m.ID}`).then((r) => r.json() as Promise<{ Text?: string; HTML?: string }>);
      for (const hit of `${full.Text ?? ""}\n${full.HTML ?? ""}`.matchAll(/https?:\/\/[^\s"'<>\])]+verify[^\s"'<>\])]*/g)) {
        const u = hit[0].replaceAll("&amp;", "&");
        if (new URL(u).searchParams.get("type") === type) return u;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/** Every verify link of one `type` mailed to `to` and not among `seen` (no waiting beyond one read). */
export async function allLinksOfType(to: string, seen: string[], type: string): Promise<string[]> {
  const out: string[] = [];
  const list = await fetch(`${E2E_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`).then((r) => r.json() as Promise<{ messages?: { ID: string }[] }>);
  for (const m of (list.messages ?? []).filter((x) => !seen.includes(x.ID))) {
    const full = await fetch(`${E2E_MAILPIT_URL}/api/v1/message/${m.ID}`).then((r) => r.json() as Promise<{ Text?: string; HTML?: string }>);
    for (const hit of `${full.Text ?? ""}\n${full.HTML ?? ""}`.matchAll(/https?:\/\/[^\s"'<>\])]+verify[^\s"'<>\])]*/g)) {
      const u = hit[0].replaceAll("&amp;", "&");
      if (new URL(u).searchParams.get("type") === type && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

/** Follow an implicit verify link; the session tokens it redirects with, or null (with the redirect's error code). */
export async function redeemImplicit(link: string): Promise<{ access: string | null; refresh: string | null; error: string | null }> {
  const r = await fetch(link, { redirect: "manual" });
  const frag = new URLSearchParams(new URL(r.headers.get("location") ?? "", "http://x").hash.slice(1));
  return { access: frag.get("access_token"), refresh: frag.get("refresh_token"), error: frag.get("error_code") };
}
