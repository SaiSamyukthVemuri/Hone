/* eslint-disable @typescript-eslint/no-explicit-any -- the runner is driven by hand-written fakes whose shapes are the point of each case */
import { describe, expect, it } from "vitest";
import { planContractPublication } from "../../lib/machines/contract-publication";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "../../e2e/helpers/local-env";

// HON-8 D4, Privacy BB3: the hosted runner's REAL client and REAL comparison against a real owned local stack. The unit tests use fakes whose
// stored shape the test author chose; this is the only proof that what the real sync RPC stores reads back, through the real PostgREST reads,
// EQUAL to projectPlanRow for every planned mode, so the runner neither refuses its own publication nor treats a published row as different.
//
// The URL check is the injected test seam (an owned stack is http://127.0.0.1); the CLI never passes it (source guard in the unit test).

const lib = await import("../../scripts/lib/hosted-publish.mjs");
const { makeHostedClient, projectPlanRow, sha256, plannedSet, runHosted, RPC } = lib;

const plan = planContractPublication();
const same = (a: unknown, b: unknown) => sha256(JSON.stringify(a)) === sha256(JSON.stringify(b));

// OPT-IN. It publishes the real contract rows through PostgREST (committed, immutable), so it must never run in the shared DB lane where other
// suites assume an unpublished starting point (the F5 partial-publication proof). Run it by hand on an OWNED stack:
//   HONE_HOSTED_LOCAL_PROOF=1 E2E_SUPABASE_URL=... HONE_LOCAL_DB_URL=... npx vitest run -c vitest.db.config.ts tests/db/hosted-publish-local.db.test.ts
describe.skipIf(!process.env.HONE_HOSTED_LOCAL_PROOF)("the hosted client against a real local stack (BB3)", () => {
  const client = makeHostedClient({ url: E2E_SUPABASE_URL, key: E2E_SERVICE_ROLE_KEY, checkUrl: () => undefined });

  it("plans ten modes, and the fingerprint sees the sync function without reading any migrations schema", async () => {
    expect(plan.publish).toHaveLength(10);
    expect(await client.fingerprint()).toEqual({ rpcExists: true });
  });

  it("after the REAL sync RPC every planned row reads back equal to projectPlanRow, for all ten modes", async () => {
    for (const row of plan.publish) {
      const existing = await client.readContract(row);
      if (existing) expect(same(existing, projectPlanRow(row)), `${row.p_mode_key}: a row already on the stack must already equal the plan`).toBe(true);
      else await client.rpc(RPC, row);
      const back = await client.readContract(row);
      expect(back, `${row.p_mode_key} is present after publishing`).not.toBeNull();
      expect(same(back, projectPlanRow(row)), `${row.p_mode_key} reads back equal to projectPlanRow`).toBe(true);
    }
  });

  it("the existing-row comparison treats an already published row as identical, and the RPC itself is idempotent for it", async () => {
    for (const row of plan.publish) {
      const out = await client.rpc(RPC, row);
      expect(Number(out), `${row.p_mode_key}: re-sending an identical row changes nothing (RPC returns 0)`).toBe(0);
      expect(same(await client.readContract(row), projectPlanRow(row))).toBe(true);
    }
  });

  it("an end-to-end runHosted over the real client finds all ten rows unchanged and publishes nothing", async () => {
    const REF = "abcdefghijklmnopqrst";
    const HEAD = "a".repeat(40);
    const planSha = sha256(JSON.stringify(plan));
    const NOW = Date.parse("2026-11-10T12:00:00Z");
    const tok = JSON.stringify({
      approver_name: "Sam", approved_at: "2026-11-10T10:00:00Z", expires_at: "2026-11-10T20:00:00Z", environment: "production",
      project_ref: REF, plan_sha256: planSha, catalogue_commit: HEAD, action: "publish_machine_contracts", scope: plannedSet(plan),
      hosted_migration_max: "0274", expected_existing_rows: 10,
    });
    const files = new Map<string, string>();
    let rpcCalls = 0;
    const real = makeHostedClient({ url: E2E_SUPABASE_URL, key: E2E_SERVICE_ROLE_KEY, checkUrl: () => undefined });
    const d: any = {
      dryRun: false,
      env: { HONE_HOSTED_SERVICE_KEY: E2E_SERVICE_ROLE_KEY, HONE_HOSTED_URL: `https://${REF}.supabase.co`, PATH: "/bin", HOME: "/h" },
      execArgv: [], stdinTTY: true, stdoutTTY: true, productionBranch: "prod", expectTokenSha256: sha256(tok), now: () => NOW,
      stdout: () => undefined,
      plan: () => ({ plan, planSha256: planSha }),
      vpsMarker: () => null, readToken: () => tok,
      git: (a: string[]) => (a[0] === "rev-parse" ? HEAD : ""),
      isAncestorOfProduction: () => true, systemRef: () => REF, declaredMigrationMax: () => "0274", runtimeVersions: () => ({ node: process.version }),
      prompt: async (q: string) => (q.includes("plan") ? planSha.slice(0, 12) : REF.slice(-4)),
      ledger: {
        exists: (n: string) => files.has(n),
        createExclusive: (n: string, b: string) => { files.set(n, b); },
        writeAtomic: (n: string, b: string) => { files.set(n, b); },
      },
      committedReceiptExists: () => false, writeRepoReceipt: () => undefined,
      client: () => ({
        fingerprint: () => real.fingerprint(),
        readContract: (row: unknown) => real.readContract(row),
        rpc: (n: string, row: unknown) => { rpcCalls += 1; return real.rpc(n, row); },
      }),
    };
    const receipt: any = await runHosted(d);
    expect(receipt.status).toBe("complete");
    expect(receipt.unchanged).toHaveLength(10);
    expect(receipt.published).toEqual([]);
    expect(receipt.read_back_mismatches).toEqual([]);
    // the runner still calls the RPC for an existing identical row (it returns 0); that is the idempotent path, not a write.
    expect(rpcCalls).toBe(10);
  });
});
