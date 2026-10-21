import { readFileSync } from "node:fs";

// A FAKE-TIME model of lead-alert retries, built from 0213's own schedule and
// the sweep's own constants, so a proof run on it cannot drift from either.
// Minutes for schedule time; milliseconds for time inside one trigger run.

const SQL = readFileSync("supabase/migrations/0213_platform_lead_alerts.sql", "utf8");
const minutes = (lit: string) => {
  const [n, unit] = lit.split(" ");
  return Number(n) * (unit.startsWith("hour") ? 60 : 1);
};
export const BACKOFF = [...SQL.matchAll(/when \d then interval '([^']+)'|else interval '([^']+)'/g)].map((m) => minutes(m[1] ?? m[2]));
export const CUTOFF = minutes(SQL.match(/first_attempted_at > v_now - interval '([^']+)'/)![1]);
export const WINDOW = minutes(SQL.match(/coalesce\(a\.retry_requested_at, a\.event_at\) > v_now - interval '([^']+)'/)![1]);
export const MAX_ATTEMPTS = Number(SQL.match(/a\.attempt_count < (\d+)/)![1]);
export const FAIR_ORDER = /order by a\.next_attempt_at, a\.created_at/.test(SQL);

export type Trigger = { everyMin: number; atMinuteOfDay?: number; budgetMs: number; max: number };
export type SimConfig = {
  arrivals: number[];
  outage: [number, number];
  sendMs: number;
  triggers: Trigger[];
  settleReserveMs: number;
  minSendWindowMs: number;
  order: "due" | "created";
  horizonMin: number;
};
type Alert = { id: number; arrival: number; first: number | null; attempts: number; due: number; status: "pending" | "accepted" | "failed" | "expired"; lastAttempt: number };
export type SimResult = { accepted: number; failed: number; expired: number; pending: number; attempts: number; maxWaitMin: number; total: number };

export function simulate(c: SimConfig): SimResult {
  const alerts: Alert[] = c.arrivals.map((t, id) => ({ id, arrival: t, first: null, attempts: 0, due: t, status: "pending", lastAttempt: t }));
  const up = (t: number) => t < c.outage[0] || t >= c.outage[1];
  let attempts = 0;
  let maxWait = 0;
  const attempt = (a: Alert, t: number, ok: boolean) => {
    attempts += 1;
    a.attempts += 1;
    a.first ??= t;
    a.lastAttempt = t;
    maxWait = Math.max(maxWait, t - a.due);
    if (ok) a.status = "accepted";
    else if (a.attempts >= MAX_ATTEMPTS) a.status = "failed";
    else a.due = t + BACKOFF[Math.min(a.attempts - 1, BACKOFF.length - 1)];
  };
  const expire = (t: number) => {
    for (const a of alerts) {
      if (a.status !== "pending") continue;
      if (t - a.arrival >= WINDOW || (a.first !== null && t - a.first >= CUTOFF)) a.status = "expired";
    }
  };
  // Events: arrivals (the immediate post-save send, outside any sweep) and trigger ticks.
  const ticks: Array<{ t: number; trig: Trigger }> = [];
  for (const trig of c.triggers) {
    if (trig.atMinuteOfDay !== undefined) {
      for (let d = 0; d * 1440 + trig.atMinuteOfDay <= c.horizonMin; d += 1) ticks.push({ t: d * 1440 + trig.atMinuteOfDay, trig });
    } else {
      for (let t = 0; t <= c.horizonMin; t += trig.everyMin) ticks.push({ t, trig });
    }
  }
  const events = [
    ...alerts.map((a) => ({ t: a.arrival, kind: "arrive" as const, a, trig: null as Trigger | null })),
    ...ticks.map((x) => ({ t: x.t, kind: "tick" as const, a: null as Alert | null, trig: x.trig })),
  ].sort((x, y) => x.t - y.t || (x.kind === "arrive" ? -1 : 1));
  for (const e of events) {
    if (e.kind === "arrive") {
      attempt(e.a!, e.t, up(e.t));
      continue;
    }
    expire(e.t);
    const trig = e.trig!;
    let used = 0;
    let n = 0;
    while (n < trig.max && trig.budgetMs - used >= c.minSendWindowMs + c.settleReserveMs) {
      const due = alerts.filter((a) => a.status === "pending" && a.due <= e.t);
      if (due.length === 0) break;
      due.sort((x, y) => (c.order === "due" ? x.due - y.due || x.arrival - y.arrival : x.arrival - y.arrival));
      const a = due[0];
      const sendWindow = trig.budgetMs - c.settleReserveMs - used;
      const cutOff = c.sendMs > sendWindow;
      used += cutOff ? sendWindow : c.sendMs;
      // A cut-off send is ambiguous: retried later under the same key.
      attempt(a, e.t, !cutOff && up(e.t));
      n += 1;
    }
  }
  expire(c.horizonMin);
  const count = (s: Alert["status"]) => alerts.filter((a) => a.status === s).length;
  return { accepted: count("accepted"), failed: count("failed"), expired: count("expired"), pending: count("pending"), attempts, maxWaitMin: maxWait, total: alerts.length };
}
