import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// LEAD-ALERT-01 (Codex P2 4259034271): fake TRANSPORTS, not fake clients. The
// worker talks to the real supabase-js client and the real Resend SDK; only
// the fetch underneath each is faked. So a test proves the deadline's abort
// reaches the request itself, through the same code production runs.
//
// Both fakes honour `init.signal` exactly as fetch does: a held request
// rejects with an AbortError when its signal aborts, and a request with no
// signal is held FOREVER (a missing signal shows up as a test timeout, never
// as a pass). `inflight` counts requests not yet answered or cancelled.

/** How a database call misbehaves: held before or after its effect is applied. */
export type Stall = "before" | "after";

type Alert = {
  id: string;
  key: string;
  attempts: number;
  token: string | null;
  leaseUntil: number;
  nextAttemptAt: number;
  status: "pending" | "accepted" | "failed";
  frozen: unknown;
  frozenSha: string | null;
  messageId: string | null;
};

function held(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return; // never answers
    const abort = () => reject(new DOMException("This operation was aborted", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

/**
 * The 0213 worker contract, in memory: claim leases one due alert (fenced by a
 * fresh token, one counted attempt, at most five), freeze is first-writer-wins
 * for the current claim, settle applies only for the current claim.
 */
export function fakeLeadAlertDb() {
  const alerts: Alert[] = [];
  const stalls: Partial<Record<string, Stall>> = {};
  const calls: string[] = [];
  const settles: Array<Record<string, unknown>> = [];
  let inflight = 0;
  let tokens = 0;

  function apply(fn: string, args: Record<string, unknown>): unknown {
    const now = Date.now();
    if (fn === "expire_platform_lead_alerts") return 0;
    if (fn === "claim_platform_lead_alert") {
      const a = alerts.find(
        (x) => x.status === "pending" && x.nextAttemptAt <= now && x.attempts < 5 && (x.token === null || x.leaseUntil <= now),
      );
      if (!a) return [{ result: "none" }];
      a.attempts += 1;
      a.token = `tok-${(tokens += 1)}`;
      a.leaseUntil = now + Number(args.p_lease_seconds) * 1000;
      return [{
        result: "claimed", alert_id: a.id, claim_token: a.token, attempt: a.attempts, idempotency_key: a.key,
        lead_kind: "demo_request", lead_id: `lead-${a.id}`, event_at: new Date(now).toISOString(), lead_name: "N",
        lead_email: "n@prospect.test", practice_name: null, location: null, practice_type: null, practitioner_count: null,
        current_tool: null, has_notes: false, frozen_message: a.frozen, frozen_recipient_sha256: a.frozenSha,
      }];
    }
    const a = alerts.find((x) => x.id === args.p_alert_id);
    const current = !!a && a.token !== null && a.token === args.p_claim_token;
    if (fn === "freeze_platform_lead_alert_message") {
      if (!a || !current) return [{ result: "stale_claim" }];
      if (a.frozen !== null) return [{ result: "existing", message: a.frozen, recipient_sha256: a.frozenSha }];
      a.frozen = args.p_message;
      a.frozenSha = String(args.p_recipient_sha256);
      return [{ result: "frozen", message: a.frozen, recipient_sha256: a.frozenSha }];
    }
    if (fn === "settle_platform_lead_alert") {
      settles.push(args);
      if (!a || !current) return "stale_claim";
      a.token = null;
      if (args.p_outcome === "accepted") {
        a.status = "accepted";
        a.messageId = String(args.p_provider_message_id);
        return "accepted";
      }
      if (args.p_outcome === "fail" || a.attempts >= 5) {
        a.status = "failed";
        return "failed";
      }
      a.nextAttemptAt = now + 2 * 60_000;
      return "retry_scheduled";
    }
    throw new Error(`unexpected rpc ${fn}`);
  }

  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const fn = new URL(String(input)).pathname.split("/rpc/")[1];
    const args = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push(fn);
    inflight += 1;
    try {
      const stall = stalls[fn];
      if (stall === "before") return await held(init.signal);
      const answer = apply(fn, args);
      if (stall === "after") return await held(init.signal);
      return json(answer);
    } finally {
      inflight -= 1;
    }
  };

  const client: SupabaseClient = createClient("http://db.test", "service-role-test", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch },
    // Never connected; supplied so the client builds on any Node version.
    realtime: { transport: class {} as never },
  });

  return {
    client,
    calls,
    settles,
    stalls,
    alerts,
    get inflight() {
      return inflight;
    },
    add(id: string) {
      alerts.push({
        id, key: `lead-alert/${id}/1`, attempts: 0, token: null, leaseUntil: 0, nextAttemptAt: Date.now(),
        status: "pending", frozen: null, frozenSha: null, messageId: null,
      });
    },
    alert(id: string) {
      return alerts.find((x) => x.id === id)!;
    },
  };
}

/** How the provider behaves for the next requests. */
export type ProviderMode =
  /** Accepts and answers at once. */
  | "ok"
  /** Never answers; nothing is accepted. */
  | "hang"
  /** Accepts (the email WILL go out), then the answer never arrives. */
  | "accept-then-hang";

/**
 * Resend's /emails endpoint with idempotency: the first request under a key
 * delivers; a later one under the same key replays the same id. `delivered`
 * counts real deliveries.
 */
export function fakeResendFetch() {
  const byKey = new Map<string, string>();
  const requests: Array<{ key: string | null; signal: AbortSignal | null }> = [];
  let mode: ProviderMode = "ok";
  let inflight = 0;

  const fetch = async (_input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const key = new Headers(init.headers).get("Idempotency-Key");
    requests.push({ key, signal: init.signal ?? null });
    inflight += 1;
    try {
      if (mode === "hang") return await held(init.signal);
      let id = key ? byKey.get(key) : undefined;
      if (!id) {
        id = `email-${byKey.size + 1}`;
        if (key) byKey.set(key, id);
      }
      if (mode === "accept-then-hang") return await held(init.signal);
      return json({ id });
    } finally {
      inflight -= 1;
    }
  };

  return {
    fetch,
    requests,
    setMode(m: ProviderMode) {
      mode = m;
    },
    get delivered() {
      return byKey.size;
    },
    get inflight() {
      return inflight;
    },
  };
}
