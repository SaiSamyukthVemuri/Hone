import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import { E2E_APP_PORT, E2E_WEB_SERVER_ENV, E2E_SENTRY_EGRESS_LOG } from "./helpers/local-env";
import { errorEvents, eventTexts, markSentryEgress, readSentryEgress, type EgressRecord } from "./helpers/sentry-egress";

// DN-29 FENCED TWO-INSTANCE PROOF. Needs HONE_LIMITER_OUTAGE_MODE=enforce exported for the runner (and so for the lane's server)
// and NO Upstash (the lane has none). Instance A is Playwright's own `next start`; instance B is a second `next start` of the same
// build on another port with its OWN egress record. Both run under the lane's Sentry egress guard (NODE_OPTIONS preload), so every
// envelope bound for Sentry is answered by a loopback sink and recorded; nothing leaves the machine.
// The public cancel page is a refuse-class route (cancel_view): with the limiter unavailable and enforcement on it must answer the
// calm retry message, and the outage alert must reach the guard ONCE per instance per throttle interval, with no identifier.
test.skip(process.env.HONE_LIMITER_OUTAGE_MODE !== "enforce", "requires HONE_LIMITER_OUTAGE_MODE=enforce");

const PORT_B = E2E_APP_PORT + 1;
const ORIGIN_A = `http://127.0.0.1:${E2E_APP_PORT}`;
const ORIGIN_B = `http://127.0.0.1:${PORT_B}`;
const LOG_B = E2E_SENTRY_EGRESS_LOG.replace(`-${E2E_APP_PORT}.jsonl`, `-${PORT_B}.jsonl`);
// The cancel page collapses EVERY refusal (rate limit, unknown token, expired token) into one headline, by design, so the page
// text cannot tell a limiter refusal from a bad token. The decisive observable is the outage ALERT, which only the refusal path emits.
const MESSAGE = "This cancellation link can't be used right now.";
const SENTINEL = "SENTINEL-do-not-leak";

async function waitReady(origin: string) {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${origin}/login`);
      if (r.status < 500) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`instance at ${origin} did not come up`);
}

function readLog(path: string, offset: number): EgressRecord[] {
  if (!fs.existsSync(path)) return [];
  const text = fs.readFileSync(path, "utf8").slice(offset);
  return text.slice(0, text.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map((l) => JSON.parse(l) as EgressRecord);
}

test("two instances: each refuses with the calm message and alerts the operator once, nothing leaves the machine, no identifier in the event", async () => {
  test.setTimeout(240_000);
  fs.mkdirSync(path.dirname(LOG_B), { recursive: true });
  const offB = fs.existsSync(LOG_B) ? fs.statSync(LOG_B).size : 0;
  const markA = markSentryEgress();

  let b: ChildProcess | undefined;
  try {
    b = spawn("npx", ["next", "start"], {
      cwd: process.cwd(),
      env: { ...process.env, ...E2E_WEB_SERVER_ENV, PORT: String(PORT_B), NEXT_PUBLIC_APP_ORIGIN: ORIGIN_B, HONE_E2E_SENTRY_EGRESS_LOG: LOG_B },
      stdio: "ignore",
    });
    await waitReady(ORIGIN_B);

    const hit = async (origin: string) => {
      const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => fetch(`${origin}/cancel/${SENTINEL}-${i}`, { headers: { "x-forwarded-for": "203.0.113.77" } })));
      const bodies = await Promise.all(rs.map((r) => r.text()));
      return bodies;
    };
    const [bodiesA, bodiesB] = await Promise.all([hit(ORIGIN_A), hit(ORIGIN_B)]);
    const withMessage = (bodies: string[]) => bodies.filter((b) => b.includes(MESSAGE)).length;
    const shape = { A: { n: bodiesA.length, withMessage: withMessage(bodiesA), lens: [...new Set(bodiesA.map((b) => b.length))].slice(0, 5) }, B: { n: bodiesB.length, withMessage: withMessage(bodiesB), lens: [...new Set(bodiesB.map((b) => b.length))].slice(0, 5) } };
    fs.writeFileSync((process.env.TWO_INSTANCE_SENTRY_EVIDENCE ?? "/tmp/two-instance-sentry.json") + ".bodies", JSON.stringify(shape));
    expect(shape.A.withMessage, `instance A: every request answered with the collapsed refusal page (${JSON.stringify(shape)})`).toBe(bodiesA.length);
    expect(shape.B.withMessage, `instance B: every request answered with the collapsed refusal page (${JSON.stringify(shape)})`).toBe(bodiesB.length);

    await new Promise((r) => setTimeout(r, 3000)); // let the SDK flush into the guard
    const recA = readSentryEgress(markA);
    const recB = readLog(LOG_B, offB);
    const alerts = (recs: EgressRecord[]) => errorEvents(recs).filter((e) => eventTexts(e.item).some((t) => t.includes("ratelimit_outage_fallback")));
    const aAlerts = alerts(recA);
    const bAlerts = alerts(recB);
    const refusedConns = (recs: EgressRecord[]) => recs.filter((r) => r.kind === "refused").length;

    const dump = JSON.stringify({ A: { records: recA.length, alerts: aAlerts.length, rawRefused: refusedConns(recA) }, B: { records: recB.length, alerts: bAlerts.length, rawRefused: refusedConns(recB) } });
    fs.writeFileSync(process.env.TWO_INSTANCE_SENTRY_EVIDENCE ?? "/tmp/two-instance-sentry.json", dump);

    expect(aAlerts.length, `instance A alerted exactly once for 25 refused requests (${dump})`).toBe(1);
    expect(bAlerts.length, `instance B alerted exactly once for 25 refused requests (${dump})`).toBe(1);
    // no identifier in anything either instance recorded
    for (const rec of [...recA, ...recB]) {
      const s = JSON.stringify(rec);
      expect(s).not.toContain(SENTINEL);
      expect(s).not.toContain("203.0.113.77");
    }
  } finally {
    b?.kill("SIGTERM");
  }
});
