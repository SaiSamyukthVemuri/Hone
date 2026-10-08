/* eslint-disable @typescript-eslint/no-explicit-any -- mutants wrap untyped functions under test */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collect } from "../../../../scripts/eng/v2/adapter/collect.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { createReaders } from "../../../../scripts/eng/v2/adapter/internal/github/index.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { createPrimitive as realCreatePrimitive } from "../../../../scripts/eng/v2/adapter/internal/github/primitive.mjs";
import { COLLECT_ROWS, LOCAL, type CollectSut } from "./support/collect-rows";
import { fakeGhKit, primitiveRows, type FakeGhKit } from "./support/fake-gh";
import { primitiveHomes } from "./support/temp-home";
import { budgetGuard, SLOW_HOOK_MS, SLOW_ROW_MS } from "./support/budgets";

// ===========================================================================
// INDEPENDENT VERIFIER — mutation detection for the collector (SPEC-05A §5).
// Each mutant WRAPS the builder's real collect, readers or primitive with one
// intentionally unsafe change (no implementation source is read or edited). A
// mutant is detected when a named row that the real code satisfies breaks.
// ===========================================================================

const REAL: CollectSut = { collect, createReaders };

/** Wraps every reader; `hook(name, args, call, state)` decides what the collector sees. */
function wrapReaders(hook: (name: string, args: any[], call: () => any, st: { keyReads: number; memo: Map<string, any>; lastHead?: string }) => any) {
  return (opts: any) => {
    const real = createReaders(opts);
    const st = { keyReads: 0, memo: new Map<string, any>(), lastHead: undefined as string | undefined };
    const out: any = {};
    for (const name of Object.keys(real)) out[name] = (...args: any[]) => hook(name, args, () => real[name](...args), st);
    return Object.freeze(out);
  };
}
/** the 3rd key read opens the confirming pass (no retry happens in these rows' first pass) */
const inConfirm = (name: string, st: { keyReads: number }) => {
  if (name === "readPrKey") st.keyReads += 1;
  return st.keyReads > 2;
};

// Two mutants call a SECOND real reader from inside another one.
function jobsForEveryRun(opts: any) {
  const real = createReaders(opts);
  const out: any = { ...real };
  out.readCandidateRuns = (h: string) => {
    const v = real.readCandidateRuns(h);
    if (!v?.ok) return v;
    for (const run of v.record.runs) {
      const j = real.readRunJobs(run.id);
      if (!j?.ok) return j;
    }
    return v;
  };
  return Object.freeze(out);
}
function rollupBeforeReview(opts: any) {
  const real = createReaders(opts);
  let head: string | undefined;
  const out: any = { ...real };
  out.readCandidateRuns = (h: string) => ((head = h), real.readCandidateRuns(h));
  out.readReviewEvidence = (n: number) => {
    const roll = head ? real.readCommitRollup(head) : null;
    if (roll && !roll.ok) return roll;
    return real.readReviewEvidence(n);
  };
  return Object.freeze(out);
}
/** A reader that builds a different route (§7 R-ECHO-Q: no REST answer echoes its query parameters). */
const rewriteRoutes = (f: (rest: string) => string) => (opts: any) =>
  createReaders({ ...opts, request: (req: any) => opts.request(req && typeof req.rest === "string" ? { ...req, rest: f(req.rest) } : req) });

const MUTANTS: Array<[string, CollectSut, string[]]> = [
  [
    "the confirming pass is skipped: its reads are served from the first pass",
    {
      collect,
      createReaders: wrapReaders((name, args, call, st) => {
        const id = name + JSON.stringify(args);
        if (inConfirm(name, st) && st.memo.has(id)) return st.memo.get(id);
        const v = call();
        if (!st.memo.has(id)) st.memo.set(id, v);
        return v;
      }),
    },
    ["unstable-compare", "unstable-run", "unstable-review", "unstable-rollup", "unstable-blob", "key-between-head", "key-between-draft"],
  ],
  [
    "the confirming pass's failures are ignored (the first pass's answer is kept)",
    {
      collect,
      createReaders: wrapReaders((name, args, call, st) => {
        const id = name + JSON.stringify(args);
        const confirm = inConfirm(name, st);
        const v = call();
        if (!confirm && !st.memo.has(id)) st.memo.set(id, v);
        return confirm && v?.ok === false && st.memo.has(id) ? st.memo.get(id) : v;
      }),
    },
    ["interrupt-confirm-16", "interrupt-confirm-20", "interrupt-confirm-24", "interrupt-confirm-29"],
  ],
  ["jobs are read for every listed run, applicable or not (and their failures propagate)", { collect, createReaders: jobsForEveryRun }, ["jobs-scope-mixed", "golden"]],
  [
    "a production blob that differs from the local one is ignored",
    {
      collect,
      createReaders: wrapReaders((name, args, call) => {
        const v = call();
        return name === "readFileBlob" && v?.ok ? { ok: true, record: Object.freeze({ path: args[0], sha: (LOCAL().blobs as Record<string, string>)[String(args[0])] }) } : v;
      }),
    },
    ["blob-mismatch-ci", "blob-mismatch-classify", "unstable-blob"],
  ],
  [
    "observedAt is folded into the evidence hash",
    {
      collect: async (o: any) => {
        const r = await collect(o);
        return r?.ok ? { ...r, evidenceHash: createHash("sha256").update(`${r.evidenceHash}|${r.evidence.observedAt}`).digest("hex") } : r;
      },
      createReaders,
    },
    ["hash-ignores-now"],
  ],
  [
    "a failed collection returns the evidence it had so far",
    {
      collect: async (o: any) => {
        const r = await collect(o);
        return r?.ok === false ? { ...r, evidence: { schema: "eng-loop-v1/evidence@1", partial: true } } : r;
      },
      createReaders,
    },
    ["failure-contract-collect", "failure-contract-confirm", "interrupt-collect-2", "interrupt-confirm-16"],
  ],
  [
    "a failed body read is retried once instead of ending the pass",
    {
      collect,
      createReaders: wrapReaders((name, _args, call) => {
        const v = call();
        return name !== "readPrKey" && v?.ok === false ? call() : v;
      }),
    },
    ["interrupt-collect-2", "interrupt-collect-9", "interrupt-confirm-20"],
  ],
  [
    "a jobs listing that cannot be complete is treated as an empty listing",
    {
      collect,
      createReaders: wrapReaders((name, _args, call) => {
        const v = call();
        return name === "readRunJobs" && v?.ok === false ? { ok: true, record: Object.freeze({ jobs: Object.freeze([]) }) } : v;
      }),
    },
    ["jobs-too-large"],
  ],
  ["the precedence is inverted: the commit rollup is read before the review evidence", { collect, createReaders: rollupBeforeReview }, ["precedence-review-before-rollup"]],
  ["R-ECHO-Q: listing routes lose per_page=100 (GitHub's default page is 30)", { collect, createReaders: rewriteRoutes((r) => r.replace(/[&?]per_page=100/, "")) }, ["golden"]],
  ["R-ECHO-Q: the head-branch PR list loses state=all (open PRs only)", { collect, createReaders: rewriteRoutes((r) => r.replace("&state=all", "")) }, ["golden"]],
  ["R-ECHO-Q: the activity log is read for a week, not a year", { collect, createReaders: rewriteRoutes((r) => r.replace("time_period=year", "time_period=week")) }, ["golden"]],
  ["R-ECHO-Q: candidate runs lose event=pull_request", { collect, createReaders: rewriteRoutes((r) => r.replace("&event=pull_request", "")) }, ["golden"]],
  ["R-ECHO-Q: run jobs lose filter=latest", { collect, createReaders: rewriteRoutes((r) => r.replace("filter=latest&", "")) }, ["golden"]],
];

describe("collector mutation detection: the real collector, mutated, is rejected by named rows", { timeout: SLOW_ROW_MS }, () => {
  const ids = Object.keys(COLLECT_ROWS);
  const baseline = new Map<string, string | null>();

  beforeAll(async () => {
    for (const id of ids) baseline.set(id, await COLLECT_ROWS[id].check(REAL));
  }, SLOW_HOOK_MS);

  it("baseline: the real collector satisfies every named row", () => {
    const failing = ids.filter((id) => baseline.get(id) !== null).map((id) => `${id}: ${baseline.get(id)}`);
    expect(failing).toEqual([]);
  });

  for (const [name, sut, mustDetect] of MUTANTS) {
    it(`detects the UNSAFE mutant: ${name}`, async () => {
      const detected: string[] = [];
      for (const id of ids) if (baseline.get(id) === null && (await COLLECT_ROWS[id].check(sut)) !== null) detected.push(id);
      expect(detected.length, "no row that the real collector satisfies breaks under this mutant").toBeGreaterThan(0);
      for (const id of mustDetect) expect(detected, `row ${id} should detect it`).toContain(id);
    });
  }
});

describe("primitive mutation detection (SPEC-05A §5.1)", { timeout: SLOW_ROW_MS }, () => {
  // every primitive built here (real or through a mutant) is tracked and closed after each test
  const homes = primitiveHomes();
  const createPrimitive = homes.wrap(realCreatePrimitive);
  afterEach(() => homes.closeAll());
  let kit: FakeGhKit;
  let rows: ReturnType<typeof primitiveRows>;
  beforeAll(() => {
    homes.setup();
    kit = fakeGhKit();
    rows = primitiveRows(kit, kit.make("json", `process.stdout.write(JSON.stringify({ hello: "world" }));`));
  });
  afterAll(() => {
    kit.cleanup();
    homes.teardown();
  });

  it("baseline: the real primitive satisfies both rows", () => {
    expect(rows["PT-no-dedicated-token"](createPrimitive)).toBeNull();
    expect(rows["PT-child-env-from-nothing"](createPrimitive)).toBeNull();
  });

  it("detects the UNSAFE mutant: the operator's GH_TOKEN is a fallback for the dedicated token", () => {
    const mutant = (o: any) => createPrimitive({ ...o, env: { ...o.env, HONE_ENG_READ_TOKEN: o.env?.HONE_ENG_READ_TOKEN || o.env?.GH_TOKEN || process.env.GH_TOKEN } });
    expect(rows["PT-no-dedicated-token"](mutant)).not.toBeNull();
  });

  it("hygiene: no primitive home is left behind by these rows (SPEC-05A §5.1: close() removes it)", () => {
    expect(homes.maxSeen()).toBeGreaterThan(0);
    expect(homes.leftovers()).toEqual([]);
  });
});

budgetGuard("collect-mutants.verify.test.ts");
