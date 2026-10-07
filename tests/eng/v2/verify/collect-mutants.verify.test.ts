/* eslint-disable @typescript-eslint/no-explicit-any -- mutants wrap untyped functions under test */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { collect } from "../../../../scripts/eng/v2/adapter/collect.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { createReaders } from "../../../../scripts/eng/v2/adapter/internal/github/index.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { createPrimitive } from "../../../../scripts/eng/v2/adapter/internal/github/primitive.mjs";
import { COLLECT_ROWS, LOCAL, type CollectSut } from "./support/collect-rows";
import { fakeGhKit, primitiveRows, type FakeGhKit } from "./support/fake-gh";

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
];

describe("collector mutation detection: the real collector, mutated, is rejected by named rows", () => {
  const ids = Object.keys(COLLECT_ROWS);
  const baseline = new Map<string, string | null>();

  beforeAll(async () => {
    for (const id of ids) baseline.set(id, await COLLECT_ROWS[id].check(REAL));
  });

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

describe("primitive mutation detection (SPEC-05A §5.1)", () => {
  let kit: FakeGhKit;
  let rows: ReturnType<typeof primitiveRows>;
  beforeAll(() => {
    kit = fakeGhKit();
    rows = primitiveRows(kit, kit.make("json", `process.stdout.write(JSON.stringify({ hello: "world" }));`));
  });
  afterAll(() => kit.cleanup());

  it("baseline: the real primitive satisfies both rows", () => {
    expect(rows["PT-no-dedicated-token"](createPrimitive)).toBeNull();
    expect(rows["PT-child-env-from-nothing"](createPrimitive)).toBeNull();
  });

  it("detects the UNSAFE mutant: the operator's GH_TOKEN is a fallback for the dedicated token", () => {
    const mutant = (o: any) => createPrimitive({ ...o, env: { ...o.env, HONE_ENG_READ_TOKEN: o.env?.HONE_ENG_READ_TOKEN || o.env?.GH_TOKEN || process.env.GH_TOKEN } });
    expect(rows["PT-no-dedicated-token"](mutant)).not.toBeNull();
  });
});
