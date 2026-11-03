import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { E2E_SUPABASE_URL, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";
import { onLimiterUnavailable } from "@/lib/rate-limit/outage";

// DN-29 multi-instance proof, WORKER half. Not a test on its own: scripts run TWO of these as separate OS processes (two
// "instances" with their own memory, their own Supabase client, sharing only the database) against one owned local stack.
// Each waits for the same wall-clock start, then fires N CONCURRENT outage-fallback decisions through the real module
// (HONE_LIMITER_OUTAGE_MODE=enforce, no Upstash) and writes how many were allowed. Skipped unless TWO_INSTANCE_OUT is set.
// MODE=visitor: every attempt carries the SAME visitor and studio (bound 5 per visitor).
// MODE=studio:  every attempt carries a DISTINCT visitor and the SAME studio (bound 30 per studio).
const out = process.env.TWO_INSTANCE_OUT;
describe.skipIf(!out)("two-instance worker", () => {
  it("fires its share at the agreed instant", async () => {
    // the owned stack, through the paired guard in e2e/helpers/local-env.ts (the same endpoints the DB suites use)
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_WEB_SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY;
    const n = Number(process.env.TWO_INSTANCE_N ?? 12);
    const goAt = Number(process.env.TWO_INSTANCE_GO_AT);
    const run = process.env.TWO_INSTANCE_RUN as string;
    const mode = process.env.TWO_INSTANCE_MODE;
    const who = process.env.TWO_INSTANCE_WHO as string;
    while (Date.now() < goAt) await new Promise((r) => setTimeout(r, 5));
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        onLimiterUnavailable({
          kind: "book",
          routeClass: "public_book",
          reason: "disabled",
          keys: { scope: `twoinst_${run}`, visitor: mode === "visitor" ? `v_${run}` : `v_${run}_${who}_${i}`, studio: `s_${run}_${mode}` },
        }),
      ),
    );
    writeFileSync(out as string, JSON.stringify({ who, mode, n, startedOffsetMs: started - goAt, allowed: results.filter((r) => r.allowed).length, refused: results.filter((r) => !r.allowed).length }));
    expect(results).toHaveLength(n);
  }, 60_000);
});
