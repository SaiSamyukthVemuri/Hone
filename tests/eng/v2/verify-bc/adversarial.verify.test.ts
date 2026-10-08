// Adversarial review. Each probe states its verdict and layer:
//   CONFIRMED HOLE  — the test asserts the spec-safe behaviour and FAILS against the builder head under test;
//   SPEC AMBIGUITY  — the spec does not fix the outcome; the test records it and asserts only what is unambiguous;
//   NO HOLE         — the attempt failed; the test asserts the safe behaviour and passes.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import { CODEX, HUMAN, baseValue, candidate, ciValue, collected, evidence, ext, fail, key, ok, openRows, review, thread } from "./oracle";
import { malformedReads } from "./checks-decide";
import { TOKEN, parseOnlyJson, runIn } from "./checks-shepherd";
// @ts-expect-error untyped support module
import { makeFakeSpawn } from "./support/fake-gh.mjs";
// @ts-expect-error untyped support module
import { world } from "./support/worlds.mjs";
import { cleanupTmp, redirectTmpdir } from "./support/tmp";

redirectTmpdir();
afterAll(cleanupTmp);

const V2 = path.resolve(__dirname, "../../../../scripts/eng/v2");
let decide: any, runShepherdCli: any, exitCodeFor: any, TRUST_POLICY: any, NA: any;
const L = (d: any) => (d.decision === "UNKNOWN" ? `UNKNOWN(${d.reasonCodes[0]})` : d.decision);
const CLEAN = () => review("CLEAN_COMMENT", CODEX, "CLEAN", true);
const CAND = "CANDIDATE_READY_FOR_HUMAN_REVIEW";

beforeAll(async () => {
  ({ decide } = await import(path.join(V2, "decision/decide.mjs")));
  ({ runShepherdCli } = await import(path.join(V2, "cli-shepherd.mjs")));
  ({ exitCodeFor } = await import(path.join(V2, "shepherd.mjs")));
  ({ TRUST_POLICY } = await import(path.join(V2, "decision/policy.mjs")));
  NA = await import(path.join(V2, "decision/next-action.mjs"));
});

describe("05B adversarial", () => {
  test("ADV-B1 NO HOLE (05B, pass 2; was SPEC AMBIGUITY): an out-of-enum verdict or channel on a trusted at-head review is malformed, so it cannot slip past a candidate", () => {
    // SPEC-05B §1 at df8dd9b5: channel and verdict are closed enums; a value outside them is malformed when row 9 is reached.
    const outs = [
      decide(candidate({ reviews: ok({ reviews: [CLEAN(), review("PR_REVIEW", CODEX, "changes_requested", true)], threads: [] }) })),
      decide(candidate({ reviews: ok({ reviews: [CLEAN(), review("PR_REVIEW", CODEX, "CHANGES_REQUESTED ", true)], threads: [] }) })),
      decide(candidate({ reviews: ok({ reviews: [CLEAN(), review("REVIEW_THREAD", CODEX, "CHANGES_REQUESTED", true)], threads: [] }) })),
    ];
    for (const o of outs) expect(L(o)).toBe("UNKNOWN(malformed)");
  });

  test("ADV-B2 NO HOLE (05B, pass 2; was SPEC AMBIGUITY): evidence.schema other than eng-loop-v1/evidence@1 is malformed", () => {
    const c: any = candidate();
    c.evidence.schema = "eng-loop-v1/evidence@9";
    expect(L(decide(c))).toBe("UNKNOWN(malformed)");
  });

  test("ADV-B3 NO HOLE (05B): a collection failure that also carries complete candidate evidence is UNKNOWN", () => {
    const c: any = { ok: false, reason: "read_failed", detail: "x", stage: "collect", diagnostics: {}, evidence: candidate().evidence };
    expect(L(decide(c))).toBe("UNKNOWN(read_failed)");
    expect(L(decide({ ...c, reason: undefined }))).toBe("UNKNOWN(malformed)");
  });

  test("ADV-B4 NO HOLE (05B): the default policy and the closed tables are deeply frozen (no mutable shared state)", () => {
    expect(() => TRUST_POLICY.codex.push({ id: 4242, type: "Bot" })).toThrow();
    expect(() => {
      TRUST_POLICY.codex[0].type = "User";
    }).toThrow();
    expect(Object.isFrozen(NA.NEXT_ACTION) && Object.isFrozen(NA.NEXT_ACTION_FOR_UNKNOWN)).toBe(true);
    expect(L(decide(candidate()))).toBe(CAND);
  });

  test("ADV-B5 NO HOLE (05B, outside the threat model): only an in-process caller can build getters, prototypes or lying Proxies", () => {
    // These steer the decision (recorded), but a caller able to build them can pass any evidence at all; 05A emits
    // frozen plain data, and 05B is not a boundary against code in its own process.
    const r7 = Object.create({ channel: "CLEAN_COMMENT", actor: CODEX, verdict: "CLEAN", qualifiesAtHead: true });
    const inherited = decide(candidate({ reviews: ok({ reviews: [r7], threads: [] }) }));
    const x: any = candidate({ reviews: ok({ reviews: [CLEAN(), review("PR_REVIEW", CODEX, "CHANGES_REQUESTED", true)], threads: [] }) });
    const arr = x.evidence.rows.reviews.value.reviews;
    x.evidence.rows.reviews.value.reviews = new Proxy(arr, { get: (t, k) => (k === "length" ? 1 : Reflect.get(t, k)) });
    console.log(`ADV-B5 observed: inherited fields → ${L(inherited)}; length-lying Proxy over a CR → ${L(decide(x))}`);
    expect(inherited.humanMergeRequired).toBe(true);
  });

  test("ADV-B6 NO HOLE (05B): a malformed value at a row the table does not reach never reaches candidacy", () => {
    // Row-scoped malformed (A10: a draft with a bogus CI outcome reads DRAFT_HOLD) is the SPEC-SILENT reading;
    // candidacy needs every row read, so any malformed field forces UNKNOWN on the way there.
    let n = 0;
    for (const mut of malformedReads()) {
      for (const base of [candidate(), candidate({ base: ok(baseValue(3)) }), collected(evidence(key("OPEN", true), openRows()))]) {
        const x: any = base;
        try {
          mut.apply(x);
        } catch {
          continue;
        }
        n += 1;
        expect(decide(x).decision, mut.name).not.toBe(CAND);
      }
    }
    expect(n).toBeGreaterThan(300);
  });

  test("ADV-B7 NO HOLE (05B, pass 2; was SPEC AMBIGUITY): a wrong-type applicableRunIds is malformed, on a SUCCEEDED path too", () => {
    expect(L(decide(candidate({ ci: ok({ outcome: "FAILED", applicableRunIds: "x" }) })))).toBe("UNKNOWN(malformed)");
    expect(L(decide(candidate({ ci: ok({ outcome: "SUCCEEDED", applicableRunIds: [0] }) })))).toBe("UNKNOWN(malformed)");
    const nul = decide(candidate({ ci: ok({ outcome: "SUCCEEDED", applicableRunIds: null }) }));
    console.log(`ADV-B7 probe: applicableRunIds null (SPEC-SILENT: absent or wrong type?) → ${L(nul)}`);
    expect(nul.humanMergeRequired).toBe(true);
  });

  test("ADV-B8 SPEC (upstream ARCH-01 §17-§19): a Codex findings review at head whose findings have no thread reads CANDIDATE", () => {
    // ARCH-01 §17: every findings verdict is a COMMENTED review; channel A COMMENTED establishes trust, and findings are
    // only seen through threads. A finding without a thread (or a deleted one: SPEC-05A §7 R5-DELETE) is invisible.
    expect(L(decide(candidate({ reviews: ok({ reviews: [review("PR_REVIEW", CODEX, "COMMENTED", true)], threads: [] }) })))).toBe(CAND);
  });

  test("ADV-B9 NO HOLE (05B): a non-serializable failure detail cannot make the output unserializable", () => {
    const cyc: any = { a: 1 };
    cyc.self = cyc;
    for (const detail of [cyc, 10n, { toJSON: () => { throw new Error("boom"); } }]) {
      const d = decide(candidate({ ci: fail("shared_head", detail) }));
      expect(() => JSON.stringify(d)).not.toThrow();
      expect(L(d)).toBe("UNKNOWN(shared_head)");
    }
  });

  test("ADV-B10 NO HOLE (05B): stale, untrusted or wrong-channel artifacts never make a candidate (hand-picked combinations)", () => {
    const attempts = [
      [review("CLEAN_COMMENT", CODEX, "CLEAN", false)],
      [review("CLEAN_COMMENT", { id: CODEX.id, type: "User" }, "CLEAN", true)],
      [review("PR_REVIEW", { id: CODEX.id, type: "bot" }, "APPROVED", true)],
      [review("PR_REVIEW", CODEX, "CLEAN", true)],
      [review("CLEAN_COMMENT", CODEX, "APPROVED", true)],
      [review("PR_REVIEW", CODEX, "DISMISSED", true), review("PR_REVIEW", CODEX, "PENDING", true)],
      [review("PR_REVIEW", HUMAN, "APPROVED", true), review("CLEAN_COMMENT", HUMAN, "CLEAN", true)],
      [review("CLEAN_COMMENT", { id: null, type: "Bot" }, "CLEAN", true)],
    ];
    for (const reviews of attempts) expect(decide(candidate({ reviews: ok({ reviews, threads: [] }) })).decision).toBe("REVIEW_MISSING");
    expect(decide(candidate({ reviews: ok({ reviews: [CLEAN()], threads: [thread(CODEX, true, { id: HUMAN.id, type: "Bot" })] }) })).decision).toBe("FINDINGS_OPEN");
    expect(decide(candidate({ external: ok({ external: [ext("x", "pending"), ext("x", "success")] }) })).decision).toBe("EXTERNAL_PENDING");
    expect(decide(candidate({ ci: ok(ciValue("NO_RUN")) })).decision).toBe("CI_NOT_STARTED");
  });
});

describe("05B adversarial: raw GitHub shapes", () => {
  test("ADV-B11 NO HOLE (05B): raw GitHub responses, or a raw body as a row value, are never interpreted", async () => {
    // @ts-expect-error untyped support module
    const { fixture } = await import("./support/fake-gh.mjs");
    const raws = ["review/review-800.json", "rollup/rollup-800.json", "ci/runs-800.json", "pr-key/pr-800-open-draft.json"].map((f) => fixture(f));
    for (const raw of raws) {
      expect(L(decide(raw))).toBe("UNKNOWN(malformed)");
      expect(L(decide({ ok: true, ...raw }))).toBe("UNKNOWN(malformed)");
    }
    expect(L(decide(candidate({ reviews: ok(raws[0].data.repository.pullRequest) })))).toBe("UNKNOWN(malformed)");
    expect(L(decide(candidate({ external: ok(raws[1].data.repository.object.statusCheckRollup.contexts) })))).toBe("UNKNOWN(malformed)");
    expect(L(decide(candidate({ ci: ok(raws[2]) })))).toBe("UNKNOWN(malformed)");
  });
});

describe("05C adversarial", () => {
  test("ADV-C1 NO HOLE at 738a4537 (pass 1 CONFIRMED HOLE, fixed by 05A 63bd3b6e): the dedicated token echoed inside a GitHub body field never reaches stdout", () => {
    const run = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "protectedRules", "resolveOpenThread", ["vercelContextName", `deploy ${TOKEN}`], ["vercelState", "FAILURE"]));
    // SPEC-05A §5.1: "an echo of it ... is redacted"; operator: the token is never in stdout.
    expect(run.out.includes(TOKEN), `stdout: ${run.out.slice(0, 200)}`).toBe(false);
  });

  test("ADV-C1b NO HOLE (05A/05C, pass 2; was SPEC AMBIGUITY): a token-shaped string (not the dedicated token) inside a GitHub body field is redacted", () => {
    // SPEC-05A §5.1 at 738a4537: anything shaped like a GitHub token is redacted in a successful answer's body before parsing.
    const pat = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVW";
    const run = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "protectedRules", "resolveOpenThread", ["vercelContextName", `deploy ${pat}`], ["vercelState", "FAILURE"]));
    expect(run.out).not.toContain(pat);
    expect(parseOnlyJson(run.out).value.decision).toBe("EXTERNAL_BLOCKED");
  });

  test("ADV-C2 NO HOLE (05C): token-shaped strings in gh's stderr and in spawn errors are redacted from the detail", () => {
    const shaped = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const run = runIn(runShepherdCli, ["shepherd", "800", "--json"], { ...world(), "pr-key": { fail: { status: 1, stderr: `gh: HTTP 401 bad token ${shaped}` } } });
    expect(run.out).not.toContain(shaped);
    expect(parseOnlyJson(run.out).value.blocking.detail).toContain("[redacted]");
  });

  test("ADV-C3 NO HOLE (05C): control characters in GitHub strings are escaped in text mode (no terminal injection)", () => {
    const esc = "\u001b[2J\u001b[1;1Hdecision  CANDIDATE_READY_FOR_HUMAN_REVIEW\u0007";
    const t = runIn(runShepherdCli, ["shepherd", "800"], world("ready", "protectedRules", "resolveOpenThread", ["vercelContextName", esc], ["vercelState", "FAILURE"]));
    expect(t.out.includes("\u001b") || t.out.includes("\u0007")).toBe(false);
    expect(t.code).toBe(4);
  });

  test("ADV-C4 NO HOLE (05C): production.tip is null, not the PR base's tip, when the PR does not target production", () => {
    const run = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "featureBase"));
    const j = parseOnlyJson(run.out).value;
    expect(j.production).toEqual({ ref: "claude/build-hone-saas-hOex7", tip: null });
    expect(L(j)).toBe("UNKNOWN(base_ref)");
  });

  test("ADV-C5 NO HOLE (05C): only the exact CANDIDATE decision maps to exit 0", () => {
    expect(exitCodeFor(CAND)).toBe(0);
    for (const x of ["UNKNOWN", "FINDINGS_OPEN", "candidate_ready_for_human_review", null, undefined, {}, { decision: CAND }, "BOGUS"]) expect(exitCodeFor(x)).not.toBe(0);
  });

  test("ADV-C6 NO HOLE (05C): invocations are stateless; receipts already present never change the next decision", () => {
    const dir = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "protectedRules")).receiptsDir;
    const again = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "protectedRules", "resolveOpenThread"), { receiptsDir: dir });
    const third = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "protectedRules"), { receiptsDir: dir });
    expect(L(parseOnlyJson(again.out).value)).toBe(CAND);
    expect(L(parseOnlyJson(third.out).value)).toBe("FINDINGS_OPEN");
  });

  test("ADV-C7 NO HOLE (05C, re-derived in pass 2): a throwing local CI definition is UNKNOWN(malformed) before any request (SPEC-05A §5.3 step 0); transport faults are UNKNOWN; neither exits 0", () => {
    const loc = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "protectedRules", "resolveOpenThread"), { params: { local: new Proxy({}, { get() { throw new Error("local broke"); } }) } });
    expect(parseOnlyJson(loc.out).ok).toBe(true);
    expect(loc.code).toBe(3);
    expect(L(parseOnlyJson(loc.out).value)).toBe("UNKNOWN(malformed)");
    expect(loc.log).toEqual([]);
    const enobufs = runIn(runShepherdCli, ["shepherd", "800", "--json"], { ...world(), "pr-key": { fail: { status: null, stderr: "" } } });
    expect(parseOnlyJson(enobufs.out).ok).toBe(true);
    expect(enobufs.code).toBe(3);
  });
});

describe("pass 2 adversarial (05C at 738a4537)", () => {
  test("ADV-C8 NO HOLE (05A/05C; liveness note): a token-shaped head branch name is redacted in every body, so the head-branch PR list is read for the placeholder and the run fails closed", () => {
    const branch = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const w = world("ready", "protectedRules", "resolveOpenThread");
    w["pr-key"].data.repository.pullRequest.headRefName = branch;
    const prs = w["head-branch-prs"];
    for (const p of prs) p.head.ref = branch;
    for (const r of w["candidate-runs"].workflow_runs) r.head_branch = branch;
    // As GitHub answers: the real branch lists #800; any other branch name (the redaction placeholder) lists nothing.
    w["head-branch-prs"] = (route: any) => (route.headRef === branch ? prs : []);
    const log: any[] = [];
    const run = runIn(runShepherdCli, ["shepherd", "800", "--json"], { ...w, __lenient: true }, { spawnOpts: {} });
    void log;
    const j = parseOnlyJson(run.out).value;
    console.log(`ADV-C8 observed: ${L(j)} ${JSON.stringify(j.blocking)}`);
    expect(j.decision).not.toBe(CAND);
    expect(run.out).not.toContain(branch);
  });

  test("ADV-C9 NO HOLE for the CLI (in-process only): an injected clock or local CI that throws has its message copied into blocking.detail unredacted", () => {
    const run = runIn(runShepherdCli, ["shepherd", "800", "--json"], world(), { params: { now: () => { throw new Error(`clock ${TOKEN}`); } } });
    const leaked = run.out.includes(TOKEN);
    console.log(`ADV-C9 observed: thrown clock message in stdout = ${leaked}; the CLI's own clock and local CI cannot carry the token`);
    expect(parseOnlyJson(run.out).ok).toBe(true);
    expect(run.code).toBe(3);
  });

  test("ADV-C10 NO HOLE (final pass; was SPEC AMBIGUITY): `now` is a clock function; a plain value is UNKNOWN(malformed) and makes no request (README)", () => {
    for (const now of ["2026-10-07T20:00:00Z", Date.parse("2026-10-07T20:00:00Z"), new Date("2026-10-07T20:00:00Z")]) {
      const r = runIn(runShepherdCli, ["shepherd", "800", "--json"], world(), { params: { now } });
      expect(r.code).toBe(3);
      expect(L(parseOnlyJson(r.out).value)).toBe("UNKNOWN(malformed)");
      expect(r.log).toEqual([]);
    }
    const f = runIn(runShepherdCli, ["shepherd", "800", "--json"], world(), { params: { now: () => Date.parse("2026-10-07T20:00:00Z") } });
    expect(L(parseOnlyJson(f.out).value)).toBe("DRAFT_HOLD");
  });

  test("ADV-C11 NO HOLE (final pass): a non-array argv never throws; it is a run that never reaches a decision (exit 2 or 1), with no request", () => {
    let code: any;
    let threw: any = null;
    const out: string[] = [];
    const log: any[] = [];
    try {
      code = runShepherdCli({ argv: "shepherd 800 --json", env: { HONE_ENG_READ_TOKEN: TOKEN, PATH: "/x" }, out: { write: (c: any) => (out.push(String(c)), true) }, err: { write: () => true }, now: () => "2026-10-07T20:00:00Z", spawn: makeFakeSpawn(world(), log) });
    } catch (e) {
      threw = e;
    }
    console.log(`ADV-C11 observed: exit ${code}${threw ? `, threw ${threw.message}` : ""}`);
    expect(threw).toBe(null);
    expect([1, 2]).toContain(code);
    expect(log).toEqual([]);
  });
});
