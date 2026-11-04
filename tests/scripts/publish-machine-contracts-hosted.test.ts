/* eslint-disable @typescript-eslint/no-explicit-any -- the runner is driven by hand-written fakes whose shapes are the point of each case */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HON-8 D4: the hosted publication runner, against FAKES. Nothing here reaches a network, a key or a real ledger. Design:
// machines/HON8-D4-HOSTED-RUNNER-DESIGN.md v2; tests answer Insurance C1-C8 and Privacy F1-F7.

const lib = await import("../../scripts/lib/hosted-publish.mjs");
const { runHosted, sha256, redact, Refusal, projectPlanRow, plannedSet, makeHostedClient, makeFsLedger, KEY_VAR, URL_VAR } = lib;
const root = join(__dirname, "../..");

const REF = "abcdefghijklmnopqrst";
const KEY = "sk-secret-service-key-ABC123";
const HEAD = "a".repeat(40);
const ROW = (mode: string) => ({
  p_machine_profile_id: "fixture:p", p_machine_profile_version: 3, p_mode_key: mode, p_channels_max: null, p_requires_installed_option: null,
  p_fields: [{ stage_key: "", field_key: "time", native_unit: "s", decimals: 1, quantity: "duration", optional: false, value_kind: "number", choices: [] }],
});
const PLAN = { publish: [ROW("flash"), ROW("blend"), ROW("electrolysis")], skipped: [] };
const PLAN_SHA = sha256(JSON.stringify(PLAN));
const NOW = Date.parse("2026-11-10T12:00:00Z");

function token(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    approver_name: "Sam", approved_at: "2026-11-10T10:00:00Z", expires_at: "2026-11-10T20:00:00Z", environment: "production",
    project_ref: REF, plan_sha256: PLAN_SHA, catalogue_commit: HEAD, action: "publish_machine_contracts", scope: plannedSet(PLAN), hosted_migration_max: "0274", expected_existing_rows: 0, ...over,
  });
}

/** Everything a valid run needs; each test breaks exactly one thing. */
function deps(over: Record<string, unknown> = {}, tokenOver: Record<string, unknown> = {}) {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const stored = new Map<string, unknown>();
  const tok = token(tokenOver);
  const d: any = {
    dryRun: false,
    env: { [KEY_VAR]: KEY, [URL_VAR]: `https://${REF}.supabase.co`, PATH: "/bin", HOME: "/h" } as Record<string, string | undefined>,
    execArgv: [], stdinTTY: true, stdoutTTY: true, productionBranch: "prod", expectTokenSha256: sha256(tok), now: () => NOW,
    stdout: (s: string) => calls.push(`stdout:${s}`),
    plan: () => ({ plan: PLAN, planSha256: PLAN_SHA }),
    vpsMarker: () => null,
    readToken: () => tok,
    git: (a: string[]) => (a[0] === "rev-parse" ? HEAD : ""),
    isAncestorOfProduction: () => true,
    systemRef: () => REF,
    declaredMigrationMax: () => "0274",
    runtimeVersions: () => ({ node: "v24" }),
    prompt: async (q: string) => (q.includes("plan") ? PLAN_SHA.slice(0, 12) : REF.slice(-4)),
    ledger: {
      exists: (n: string) => files.has(n),
      createExclusive: (n: string, b: string) => { if (files.has(n)) throw Object.assign(new Error("exists"), { code: "EEXIST" }); calls.push(`ledger:${n}`); files.set(n, b); },
      writeAtomic: (n: string, b: string) => { calls.push(`ledger:${n}`); files.set(n, b); },
    },
    committedReceiptExists: () => false,
    writeRepoReceipt: () => { calls.push("repo-receipt"); },
    client: () => ({
      async fingerprint() { calls.push("fingerprint"); return { rpcExists: true }; },
      async readContract(row: any) { calls.push(`read:${row.p_mode_key}`); return stored.get(row.p_mode_key) ?? null; },
      async rpc(_n: string, row: any) { calls.push(`rpc:${row.p_mode_key}`); stored.set(row.p_mode_key, projectPlanRow(row)); return 1; },
    }),
    ...over,
  };
  return { d, files, calls, stored, tok };
}
const refused = async (d: any, re: RegExp) => {
  const e = await runHosted(d).then(() => null, (x: Error) => x);
  expect(e, "must refuse").toBeInstanceOf(Refusal);
  expect((e as Error).message).toMatch(re);
};
const noNetwork = (calls: string[]) => expect(calls.filter((c) => /^(fingerprint|read:|rpc:|ledger:)/.test(c))).toEqual([]);

describe("control: a fully valid run publishes, reads back, and writes a finished receipt", () => {
  it("publishes in plan order, never twice, and the receipt carries no ref, no name, no key", async () => {
    const { d, calls, files } = deps();
    const r = await runHosted(d);
    expect(calls.filter((c) => c.startsWith("rpc:"))).toEqual(["rpc:flash", "rpc:blend", "rpc:electrolysis"]);
    expect(r.status).toBe("complete");
    const body = [...files.values()].join("\n") + JSON.stringify(r);
    expect(body).not.toContain(REF);
    expect(body).not.toContain(KEY);
    expect(body).not.toContain("Sam");
    expect(r.approver_role).toBe("owner");
    expect(r.project_ref_fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(r.key_binding).toBe("url_only");
  });
});

describe("startup refusals: every one happens before any network call, ledger write, or key use (F1, F3, C3)", () => {
  const cases: Array<[string, (d: any) => void, RegExp]> = [
    ["HTTPS_PROXY", (d) => { d.env.HTTPS_PROXY = "http://p"; }, /HTTPS_PROXY/],
    ["lowercase http_proxy", (d) => { d.env.http_proxy = "http://p"; }, /http_proxy/],
    ["ALL_PROXY", (d) => { d.env.ALL_PROXY = "socks5://p"; }, /ALL_PROXY/],
    ["NODE_TLS_REJECT_UNAUTHORIZED", (d) => { d.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; }, /NODE_TLS_REJECT_UNAUTHORIZED/],
    ["NODE_EXTRA_CA_CERTS", (d) => { d.env.NODE_EXTRA_CA_CERTS = "/x.pem"; }, /NODE_EXTRA_CA_CERTS/],
    ["NODE_OPTIONS", (d) => { d.env.NODE_OPTIONS = "--require /x"; }, /NODE_OPTIONS/],
    ["inspector flag", (d) => { d.execArgv = ["--inspect=9229"]; }, /inspector/],
    ["CI", (d) => { d.env.CI = "true"; }, /CI is set/],
    ["GITHUB_ACTIONS", (d) => { d.env.GITHUB_ACTIONS = "true"; }, /GITHUB_ACTIONS/],
    ["stdin not a TTY", (d) => { d.stdinTTY = false; }, /terminal/],
    ["stdout not a TTY", (d) => { d.stdoutTTY = false; }, /terminal/],
    ["VPS marker", (d) => { d.vpsMarker = () => "heavy-slot file"; }, /VPS marker/],
  ];
  for (const [name, mutate, re] of cases) {
    it(`${name} is refused`, async () => {
      const { d, calls } = deps();
      mutate(d);
      await refused(d, re);
      noNetwork(calls);
      expect(d.env[KEY_VAR], "the key was not even consumed").toBe(KEY);
    });
  }
  for (const [name, url] of [
    ["http", `http://${REF}.supabase.co`], ["a path", `https://${REF}.supabase.co/x`], ["a port", `https://${REF}.supabase.co:8443`],
    ["userinfo", `https://u:p@${REF}.supabase.co`], ["a query", `https://${REF}.supabase.co?x=1`], ["another host", `https://${REF}.example.com`],
    ["a short ref", `https://abc.supabase.co`], ["uppercase", `https://${REF.toUpperCase()}.supabase.co`],
  ] as const) {
    it(`a URL with ${name} is refused`, async () => {
      const { d, calls } = deps();
      d.env[URL_VAR] = url;
      await refused(d, /hosted URL/);
      noNetwork(calls);
    });
  }
  it("a missing key is refused", async () => {
    const { d, calls } = deps();
    delete d.env[KEY_VAR];
    await refused(d, /not set/);
    noNetwork(calls);
  });
});

describe("token and inputs: every refusal, before any write (C4, C5, C6, F4)", () => {
  const cases: Array<[string, (x: ReturnType<typeof deps>) => void, RegExp]> = [
    ["no --expect-token-sha256", ({ d }) => { d.expectTokenSha256 = undefined; }, /expect-token-sha256/],
    ["a different token sha256", ({ d }) => { d.expectTokenSha256 = "b".repeat(64); }, /not the one quoted/],
    ["wrong action", (x) => { const t = token({ action: "x" }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /action/],
    ["wrong environment", (x) => { const t = token({ environment: "preview" }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /environment/],
    ["an approver who is not Sam", (x) => { const t = token({ approver_name: "Someone" }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /Sam/],
    ["an expired token", (x) => { const t = token({ expires_at: "2026-11-10T11:00:00Z" }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /expired/],
    ["a token valid more than 24 h", (x) => { const t = token({ approved_at: "2026-11-09T00:00:00Z", expires_at: "2026-11-11T00:00:00Z" }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /24 hours/],
    ["a token for another project than the URL", (x) => { const t = token({ project_ref: "zzzzzzzzzzzzzzzzzzzz" }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /URL's project/],
    ["supabase/.temp/project-ref differing", ({ d }) => { d.systemRef = () => "zzzzzzzzzzzzzzzzzzzz"; }, /\.temp\/project-ref/],
    ["a plan that is not the token's", (x) => { const t = token({ plan_sha256: "c".repeat(64) }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /plan_sha256/],
    ["a commit that is not HEAD", (x) => { const t = token({ catalogue_commit: "b".repeat(40) }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /HEAD/],
    ["a dirty checkout", ({ d }) => { d.git = (a: string[]) => (a[0] === "rev-parse" ? HEAD : " M file"); }, /not clean/],
    ["HEAD not an ancestor of production", ({ d }) => { d.isAncestorOfProduction = () => false; }, /ancestor/],
    ["a scope with MORE than the plan", (x) => { const t = token({ scope: [...plannedSet(PLAN), "fixture:p@3:extra"] }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /EQUAL/],
    ["a scope with LESS than the plan", (x) => { const t = token({ scope: plannedSet(PLAN).slice(1) }); x.d.readToken = () => t; x.d.expectTokenSha256 = sha256(t); }, /EQUAL/],
    ["a wrong confirmation", ({ d }) => { d.prompt = async () => "wrong"; }, /confirmation/],
    ["a service key whose ref claim is another project", ({ d }) => {
      const payload = Buffer.from(JSON.stringify({ ref: "zzzzzzzzzzzzzzzzzzzz" })).toString("base64url");
      d.env[KEY_VAR] = `h.${payload}.s`;
    }, /ref claim/],
  ];
  for (const [name, mutate, re] of cases) {
    it(`${name} is refused with no write and no ledger entry`, async () => {
      const x = deps();
      mutate(x);
      await refused(x.d, re);
      noNetwork(x.calls);
    });
  }
  it("a key with a matching ref claim is accepted and recorded as bound", async () => {
    const x = deps();
    x.d.env[KEY_VAR] = `h.${Buffer.from(JSON.stringify({ ref: REF })).toString("base64url")}.s`;
    expect((await runHosted(x.d)).key_binding).toBe("jwt_ref_claim");
  });
});

describe("hosted fingerprint (F4, BB1): no migration-schema read; the target is held to what Sam bound into the token", () => {
  const noWrite = (x: any) => expect(x.calls.filter((c: string) => c.startsWith("rpc:") || c.startsWith("ledger:"))).toEqual([]);
  it("a missing RPC refuses before any intent or write", async () => {
    const x = deps();
    x.d.client = () => ({ async fingerprint() { return { rpcExists: false }; }, async readContract() { return null; }, async rpc() { x.calls.push("rpc:x"); return 1; } });
    await refused(x.d, /not present/);
    noWrite(x);
  });
  it("a token whose hosted_migration_max is not the repo's declared one is refused before any network call", async () => {
    const x = deps({}, { hosted_migration_max: "0273" });
    await refused(x.d, /hosted_migration_max/);
    noNetwork(x.calls);
  });
  it("a token without a whole expected_existing_rows is refused", async () => {
    const x = deps({}, { expected_existing_rows: undefined });
    await refused(x.d, /expected_existing_rows/);
    noNetwork(x.calls);
  });
  it("more planned rows already present than the token expects refuses with no intent and no write", async () => {
    const x = deps();
    x.stored.set("flash", projectPlanRow(ROW("flash")));
    await refused(x.d, /token expects 0/);
    noWrite(x);
  });
  it("fewer present than the token expects refuses too", async () => {
    const x = deps({}, { expected_existing_rows: 2 });
    x.stored.set("flash", projectPlanRow(ROW("flash")));
    await refused(x.d, /token expects 2/);
    noWrite(x);
  });
  it("the receipt says project kind and the migration head are ASSERTED by the token, not proven", async () => {
    const r = await runHosted(deps().d);
    expect(String(r.target_binding)).toMatch(/ASSERTED by the token/);
    expect(String(r.target_binding)).toMatch(/not proven/);
  });
  it("the real client's fingerprint reads only the OpenAPI document, never the migrations schema", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string, init: any) => { seen.push(`${url} ${JSON.stringify(init?.headers ?? {})}`); return { status: 200, ok: true, json: async () => ({ paths: { "/rpc/sync_machine_profile_contract": {} } }) }; };
    const c = makeHostedClient({ url: `https://${REF}.supabase.co`, key: KEY, fetchImpl: fetchImpl as never });
    expect(await c.fingerprint()).toEqual({ rpcExists: true });
    expect(seen.join("\n")).not.toMatch(/schema_migrations|supabase_migrations|Accept-Profile/);
  });
});

describe("single use, write-ahead intent, and partial runs (C1, C6, F2)", () => {
  it("the intent record exists BEFORE the first RPC", async () => {
    const { d, calls } = deps();
    await runHosted(d);
    const intent = calls.findIndex((c) => c.startsWith("ledger:") && c.endsWith(".intent.json"));
    const firstRpc = calls.findIndex((c) => c.startsWith("rpc:"));
    expect(intent).toBeGreaterThanOrEqual(0);
    expect(intent).toBeLessThan(firstRpc);
  });

  it("a CRASH after the first call burns the token: the second run is refused", async () => {
    const x = deps();
    let n = 0;
    x.d.client = () => ({
      async fingerprint() { return { rpcExists: true }; },
      async readContract(row: any) { return x.stored.get(row.p_mode_key) ?? null; },
      async rpc(_n: string, row: any) { x.calls.push(`rpc:${row.p_mode_key}`); if (++n === 2) throw new Error(`process died ${KEY}`); x.stored.set(row.p_mode_key, projectPlanRow(row)); return 1; },
    });
    const first = await runHosted(x.d).then(() => null, (e: Error) => e);
    expect(first!.message, "the failure is reported and redacted").not.toContain(KEY);
    expect(first!.message).toMatch(/token is burned/);
    const receipt = JSON.parse([...x.files.entries()].find(([k]) => k.endsWith(".receipt.json"))![1]);
    expect(receipt.published).toEqual(["fixture:p@3:flash"]);
    expect(receipt.attempted_uncertain).toEqual([expect.objectContaining({ id: "fixture:p@3:blend", read_back: "absent" })]);
    expect(JSON.stringify(receipt)).not.toContain(KEY);
    expect(receipt.not_attempted).toEqual(["fixture:p@3:electrolysis"]);
    expect(receipt.status).toBe("partial_or_failed_token_burned");
    // the second run, same token: refused with no new write.
    const before = x.calls.filter((c) => c.startsWith("rpc:")).length;
    const second = deps({ ledger: x.d.ledger });
    await refused(second.d, /used or started/);
    expect(second.calls.filter((c) => c.startsWith("rpc:")).length + before).toBe(before);
  });

  it("a token with an intent file only (a run killed before finishing) is refused until a person clears it", async () => {
    const x = deps();
    x.files.set(`${sha256(x.tok)}.intent.json`, "{}");
    await refused(x.d, /used or started/);
    noNetwork(x.calls);
  });

  it("a receipt already committed under docs/production refuses the token (second guard)", async () => {
    const x = deps({ committedReceiptExists: () => true });
    await refused(x.d, /used or started/);
    noNetwork(x.calls);
  });

  it("an existing row that DIFFERS aborts the whole run, nothing written, no intent", async () => {
    const x = deps();
    x.stored.set("blend", { channels_max: 9, requires_installed_option: null, fields: [] });
    await refused(x.d, /immutable/);
    expect(x.calls.filter((c) => c.startsWith("rpc:") || c.startsWith("ledger:"))).toEqual([]);
  });

  it("an identical existing row is reported UNCHANGED, not published", async () => {
    const x = deps({}, { expected_existing_rows: 1 });
    x.stored.set("flash", projectPlanRow(ROW("flash")));
    const r = await runHosted(x.d);
    expect(r.unchanged).toEqual(["fixture:p@3:flash"]);
    expect(r.published).toEqual(["fixture:p@3:blend", "fixture:p@3:electrolysis"]);
  });

  it("a read-back mismatch is reported and the receipt says so", async () => {
    const x = deps();
    x.d.client = () => ({
      async fingerprint() { return { rpcExists: true }; },
      async readContract(row: any) { return x.stored.get(row.p_mode_key) ?? null; },
      async rpc(_n: string, row: any) { x.stored.set(row.p_mode_key, { channels_max: 1, requires_installed_option: null, fields: [] }); return 1; },
    });
    await expect(runHosted(x.d)).rejects.toThrow(/read-back mismatch/);
    const receipt = JSON.parse([...x.files.entries()].find(([k]) => k.endsWith(".receipt.json"))![1]);
    expect(receipt.status).toBe("read_back_mismatch");
  });
});

describe("exclusive intent claim (G1, Codex P2 #3, BB4) and uncertain outcomes (Codex P2 #2, #1)", () => {
  it("two runs of one token over a REAL ledger directory: exactly one publishes, the other is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-race-"));
    try {
      const ledger = makeFsLedger(dir);
      const a = deps({ ledger }); const b = deps({ ledger });
      const results = await Promise.allSettled([runHosted(a.d), runHosted(b.d)]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(bad[0].reason).toBeInstanceOf(Refusal);
      expect(bad[0].reason.message).toMatch(/claimed by another run|used or started/);
      const rpcs = [...a.calls, ...b.calls].filter((c) => c.startsWith("rpc:"));
      expect(rpcs, "each mode is published once, by one run").toHaveLength(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the real createExclusive refuses an existing name (EEXIST) and leaves the first body in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-ex-"));
    try {
      const l = makeFsLedger(dir);
      l.createExclusive("i.json", "first");
      expect(() => l.createExclusive("i.json", "second")).toThrow(expect.objectContaining({ code: "EEXIST" }));
      expect(readFileSync(join(dir, "i.json"), "utf8")).toBe("first");
      l.writeAtomic("r.json", "one"); l.writeAtomic("r.json", "two");
      expect(readFileSync(join(dir, "r.json"), "utf8"), "the receipt stub IS replaceable").toBe("two");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("an intent that appears between the used-check and the claim refuses and writes nothing", async () => {
    const x = deps();
    const real = x.d.ledger.createExclusive;
    x.d.ledger.createExclusive = (n: string, b: string) => { x.files.set(n, "someone else"); return real(n, b); };
    await refused(x.d, /claimed by another run/);
    expect(x.calls.filter((c) => c.startsWith("rpc:"))).toEqual([]);
    expect(x.files.get(`${sha256(x.tok)}.intent.json`)).toBe("someone else");
  });
  it("a failed RPC whose write actually committed is recorded as attempted_uncertain with read_back present_equal... as 'equal'", async () => {
    const x = deps();
    x.d.client = () => ({
      async fingerprint() { return { rpcExists: true }; },
      async readContract(row: any) { return x.stored.get(row.p_mode_key) ?? null; },
      async rpc(_n: string, row: any) { x.stored.set(row.p_mode_key, projectPlanRow(row)); throw new Error("network reset after commit"); },
    });
    await expect(runHosted(x.d)).rejects.toThrow(/token is burned/);
    const receipt = JSON.parse([...x.files.entries()].find(([k]) => k.endsWith(".receipt.json"))![1]);
    expect(receipt.attempted_uncertain).toEqual([expect.objectContaining({ id: "fixture:p@3:flash", read_back: "equal" })]);
    expect(receipt.published).toEqual([]);
    expect(receipt.not_attempted).toEqual(["fixture:p@3:blend", "fixture:p@3:electrolysis"]);
  });
  it("a read-back REQUEST that fails still finalizes the receipt, names the rows, and exits non-zero with the token burned", async () => {
    const x = deps();
    let after = false;
    x.d.client = () => ({
      async fingerprint() { return { rpcExists: true }; },
      async readContract(row: any) { if (after) throw new Error(`503 ${KEY}`); return x.stored.get(row.p_mode_key) ?? null; },
      async rpc(_n: string, row: any) { x.stored.set(row.p_mode_key, projectPlanRow(row)); if (row.p_mode_key === "electrolysis") after = true; return 1; },
    });
    await expect(runHosted(x.d)).rejects.toThrow(/read-back could not be completed/);
    const raw = [...x.files.entries()].find(([k]) => k.endsWith(".receipt.json"))![1];
    const receipt = JSON.parse(raw);
    expect(receipt.status).toBe("read_back_unverified_token_burned");
    expect(receipt.read_back_unreadable).toHaveLength(3);
    expect(raw).not.toContain(KEY);
    expect(receipt.published).toHaveLength(3);
  });
});

describe("approval expiry is rechecked before the first hosted write (Codex P2)", () => {
  const EXP = Date.parse("2026-11-10T20:00:00Z");
  it("an approval that runs out during the prompt/reads is refused with no intent and no write", async () => {
    const x = deps();
    let clock = NOW;
    x.d.now = () => clock;
    const real = x.d.client;
    x.d.client = (a: unknown) => { const c = real(a); return { ...c, async readContract(r: any) { clock = EXP; return c.readContract(r); } }; };
    await refused(x.d, /expired before the first hosted write/);
    expect(x.calls.filter((c) => c.startsWith("rpc:") || c.startsWith("ledger:"))).toEqual([]);
  });
  it("an approval that runs out between the intent claim and the first RPC writes nothing and finalizes a burned receipt", async () => {
    const x = deps();
    let clock = NOW;
    x.d.now = () => clock;
    const real = x.d.ledger.createExclusive;
    x.d.ledger.createExclusive = (n: string, b: string) => { real(n, b); clock = EXP; };
    await refused(x.d, /token is burned/);
    expect(x.calls.filter((c) => c.startsWith("rpc:"))).toEqual([]);
    const receipt = JSON.parse([...x.files.entries()].find(([k]) => k.endsWith(".receipt.json"))![1]);
    expect(receipt.status).toBe("expired_before_first_write_token_burned");
    expect(receipt.not_attempted).toHaveLength(3);
    expect(receipt.published).toEqual([]);
    // and the token stays used
    await refused(deps({ ledger: x.d.ledger }).d, /used or started/);
  });
  it("control: just before expiry the run still completes", async () => {
    const x = deps();
    x.d.now = () => EXP - 1;
    expect((await runHosted(x.d)).status).toBe("complete");
  });
});

describe("receipt durability (C7)", () => {
  it("a receipt-write failure after publishing prints the body and exits non-zero", async () => {
    const x = deps();
    let n = 0;
    x.d.ledger = { exists: () => false, createExclusive: () => {}, writeAtomic: () => { if (++n > 1) throw new Error("disk full"); } };
    await expect(runHosted(x.d)).rejects.toThrow(/receipt could not be written/);
    const printed = x.calls.find((c) => c.startsWith("stdout:RECEIPT WRITE FAILED"));
    expect(printed, "the body is on stdout").toBeDefined();
    expect(printed).not.toContain(KEY);
  });
});

describe("the key never leaves the process (F1)", () => {
  it("is removed from the environment object once read", async () => {
    const x = deps();
    await runHosted(x.d);
    expect(x.d.env[KEY_VAR]).toBeUndefined();
  });
  it("redact removes the key, a bearer header and anything JWT-shaped", () => {
    const text = `boom ${KEY} Authorization: Bearer abc.def apikey=zzz eyJhbGciOi.eyJyZWYiOiJ4In0.sig12345678`;
    const out = redact(text, KEY);
    expect(out).not.toContain(KEY);
    expect(out).not.toMatch(/abc\.def|zzz|eyJhbGci/);
  });
  it("the real client refuses a redirect and never calls anything but select reads and the one RPC", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string, init: any) => { seen.push(`${init?.method ?? "GET"} ${url}`); return { status: 302, ok: false, json: async () => ({}) }; };
    const c = makeHostedClient({ url: `https://${REF}.supabase.co`, key: KEY, fetchImpl: fetchImpl as never });
    await expect(c.readContract(ROW("flash"))).rejects.toThrow(/redirect/);
    await expect(c.rpc("some_other_function", {})).rejects.toThrow(/only the contract sync RPC/);
    expect(seen.every((s) => s.startsWith("GET "))).toBe(true);
    expect(() => makeHostedClient({ url: "http://x.supabase.co", key: KEY })).toThrow();
  });
});

describe("source guards", () => {
  const lib = readFileSync(join(root, "scripts/lib/hosted-publish.mjs"), "utf8");
  const cli = readFileSync(join(root, "scripts/publish-machine-contracts-hosted.mjs"), "utf8");
  it("the CLI never passes the URL-check seam, and the lib never reads the migrations schema (BB3, BB1)", () => {
    expect(cli).not.toMatch(/checkUrl/);
    expect(lib).not.toMatch(/Accept-Profile|supabase_migrations|schema_migrations/);
    expect(lib).not.toMatch(/projectKind/);
  });
  it("makes no raw table write: only .rpc of the sync function and select reads", () => {
    expect(lib).not.toMatch(/method:\s*["'](PATCH|PUT|DELETE)["']/);
    expect(lib).not.toMatch(/\b(insert|update|delete|truncate)\s+(into|from|public)/i);
    const posts = [...lib.matchAll(/method:\s*["']POST["']/g)];
    expect(posts).toHaveLength(1);
    expect(lib).toMatch(/\/rest\/v1\/rpc\/\$\{name\}/);
    expect(lib).toMatch(/name !== RPC/);
  });
  it("never logs or writes the key variable, and every error goes through redaction", () => {
    for (const src of [lib, cli]) {
      // Printing the key means passing it as an argument or interpolating it; mentioning the variable NAME in a usage string is fine.
      expect(src).not.toMatch(/console\.\w+\(\s*(key|d\.env\[KEY_VAR\]|process\.env\[?\.?\w*KEY)/);
      // The only interpolations of the key or its variable NAME: the request header, and the "is not set" refusal (a name, not a value).
      const hits = [...src.matchAll(/\$\{[^}]*(\bkey\b|KEY_VAR|SERVICE_KEY)[^}]*\}/g)].map((m) => m[0]).sort();
      expect(hits).toEqual(src === lib ? ["${KEY_VAR}", "${key}"].sort() : []);
    }
    expect(lib).toMatch(/delete d\.env\[KEY_VAR\]/);
    expect(lib).toMatch(/redactErr/);
  });
  it("child processes get a scrubbed environment, not the process environment", () => {
    // Every child process call carries the scrubbed env (the `env: process.env` passed to runHosted is the in-process object, not a child's).
    const calls = cli.match(/execFileSync\(/g)!.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(cli.match(/execFileSync\([^;]*env:\s*scrubbed/g)!.length).toBe(calls);
    expect(cli).not.toMatch(/(spawn|exec|fork)(Sync)?\([^;]*env:\s*process\.env/);
    expect(cli).toMatch(/const scrubbed = \{ PATH/);
  });
  it("the hosted file is not reachable from the local tool (no shared hosted path)", () => {
    const local = readFileSync(join(root, "scripts/publish-machine-contracts.mjs"), "utf8");
    expect(local).not.toMatch(/hosted-publish|HONE_HOSTED/);
  });
});

describe("dry run (what the VPS runs): no key, no network, no terminal, no write", () => {
  it("with the key present, never reads it, never calls a client, a ledger or a prompt", async () => {
    const reads: string[] = [];
    const env = new Proxy({ [KEY_VAR]: KEY } as Record<string, string>, { get: (t, k) => { reads.push(String(k)); return t[k as string]; }, has: (t, k) => { reads.push(String(k)); return k in t; } });
    const x = deps({ dryRun: true, env, stdinTTY: false, stdoutTTY: false, vpsMarker: () => "heavy-slot file" });
    x.d.client = () => { throw new Error("a client was constructed"); };
    x.d.prompt = async () => { throw new Error("a prompt was shown"); };
    const out = await runHosted(x.d);
    expect(out).toMatchObject({ dryRun: true, planSha256: PLAN_SHA });
    expect(reads).not.toContain(KEY_VAR);
    expect(x.calls).toEqual([]);
  });
  it("the real CLI dry-run gives the SAME plan sha256 in two locales and time zones, and equals the local tool's", () => {
    const run = (env: Record<string, string>) => {
      const out = execFileSync("node", ["scripts/publish-machine-contracts-hosted.mjs", "--dry-run"], { cwd: root, env: { PATH: process.env.PATH!, ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
      return JSON.parse(out).plan_sha256 as string;
    };
    const a = run({ LANG: "C", TZ: "UTC" });
    const b = run({ LANG: "tr_TR.UTF-8", TZ: "Asia/Tokyo" });
    const local = JSON.parse(execFileSync("node", ["scripts/publish-machine-contracts.mjs", "--dry-run"], { cwd: root, env: { PATH: process.env.PATH! } as unknown as NodeJS.ProcessEnv, encoding: "utf8" })).sha256;
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(b).toBe(a);
    expect(a).toBe(local);
  }, 120_000);
  it("the CLI with --publish and no terminal, no token or in CI refuses with exit code 3 or 2 and no key use", () => {
    const run = (extra: string[], env: Record<string, string> = {}) => {
      try {
        execFileSync("node", ["scripts/publish-machine-contracts-hosted.mjs", ...extra], { cwd: root, env: { PATH: process.env.PATH!, ...env } as unknown as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return 0;
      } catch (e) { return (e as { status: number }).status; }
    };
    expect(run(["--publish"])).toBe(2);
    expect(run(["--publish", "--approval=/tmp/x", `--expect-token-sha256=${"a".repeat(64)}`], { [KEY_VAR]: KEY, [URL_VAR]: `https://${REF}.supabase.co` })).toBe(3);
  }, 120_000);
});
