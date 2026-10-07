// Adversarial review. Each probe states its verdict and layer:
//   CONFIRMED HOLE  — the test asserts the spec-safe behaviour and FAILS against efc7e186;
//   SPEC AMBIGUITY  — the spec does not fix the outcome; the test records it and asserts only what is unambiguous;
//   NO HOLE         — the attempt failed; the test asserts the safe behaviour and passes.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import { CODEX, HUMAN, baseValue, candidate, ciValue, collected, evidence, ext, fail, key, ok, openRows, review, thread } from "./oracle";
import { malformedReads } from "./checks-decide";
import { TOKEN, parseOnlyJson, runIn } from "./checks-shepherd";
// @ts-expect-error untyped support module
import { world } from "./support/worlds.mjs";

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
  test("ADV-B1 SPEC AMBIGUITY (05B): an out-of-enum verdict or channel on a trusted at-head review is inert, so it cannot block a candidate", () => {
    const outs = [
      decide(candidate({ reviews: ok({ reviews: [CLEAN(), review("PR_REVIEW", CODEX, "changes_requested", true)], threads: [] }) })),
      decide(candidate({ reviews: ok({ reviews: [CLEAN(), review("PR_REVIEW", CODEX, "CHANGES_REQUESTED ", true)], threads: [] }) })),
      decide(candidate({ reviews: ok({ reviews: [CLEAN(), review("REVIEW_THREAD", CODEX, "CHANGES_REQUESTED", true)], threads: [] }) })),
    ];
    // SPEC-05B §3 "any other verdict or channel establishes nothing" vs §0 "input outside the contract → malformed"
    // (ARCH-01 §24 types both as closed enums). Unreachable through 05A: bindReviews refuses states outside GitHub's five.
    console.log(`ADV-B1 observed: ${outs.map(L).join(", ")}`);
    for (const o of outs) expect(o.humanMergeRequired).toBe(true);
  });

  test("ADV-B2 SPEC AMBIGUITY (05B): evidence.schema is not checked; an @9 evidence decides as @1", () => {
    const c: any = candidate();
    c.evidence.schema = "eng-loop-v1/evidence@9";
    console.log(`ADV-B2 observed: ${L(decide(c))}`);
    expect(decide(c).humanMergeRequired).toBe(true);
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

  test("ADV-B7 SPEC AMBIGUITY (05B, §1 minor): a wrong-type optional applicableRunIds becomes [] instead of malformed (never on the candidacy path)", () => {
    const d = decide(candidate({ ci: ok({ outcome: "FAILED", applicableRunIds: "x" }) }));
    console.log(`ADV-B7 observed: ${L(d)} ${JSON.stringify(d.blocking)}`);
    expect(d.decision).not.toBe(CAND);
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
  test("ADV-C1 CONFIRMED HOLE (low; 05C output of a 05A redaction gap): the dedicated token echoed inside a GitHub body field reaches stdout", () => {
    const run = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "protectedRules", "resolveOpenThread", ["vercelContextName", `deploy ${TOKEN}`], ["vercelState", "FAILURE"]));
    // SPEC-05A §5.1: "an echo of it ... is redacted"; operator: the token is never in stdout.
    expect(run.out.includes(TOKEN), `stdout: ${run.out.slice(0, 200)}`).toBe(false);
  });

  test("ADV-C1b SPEC AMBIGUITY (05A/05C): a token-shaped string (not the dedicated token) inside a GitHub body field is printed unredacted", () => {
    // SPEC-05A §5.1 redacts "anything shaped like a GitHub token" in gh's echo; whether that covers body data that
    // 05C prints (a failing context's name) is not stated. Recorded.
    const pat = "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVW";
    const run = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "protectedRules", "resolveOpenThread", ["vercelContextName", `deploy ${pat}`], ["vercelState", "FAILURE"]));
    console.log(`ADV-C1b observed: token-shaped body string in stdout = ${run.out.includes(pat)}`);
    expect(parseOnlyJson(run.out).ok).toBe(true);
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

  test("ADV-C7 NO HOLE (05C): internal errors and transport faults still print exactly one JSON document and never exit 0", () => {
    const loc = runIn(runShepherdCli, ["shepherd", "800", "--json"], world("ready", "protectedRules", "resolveOpenThread"), { params: { local: new Proxy({}, { get() { throw new Error(`local broke ${TOKEN}`); } }) } });
    expect(parseOnlyJson(loc.out).ok).toBe(true);
    expect(loc.code).toBe(1);
    expect(loc.out + loc.err).not.toContain(TOKEN);
    const enobufs = runIn(runShepherdCli, ["shepherd", "800", "--json"], { ...world(), "pr-key": { fail: { status: null, stderr: "" } } });
    expect(parseOnlyJson(enobufs.out).ok).toBe(true);
    expect(enobufs.code).toBe(3);
  });
});
