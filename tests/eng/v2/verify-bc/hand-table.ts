// Hand-derived cases: each expectation is written literally from SPEC-05B §2-§3 (and README V1 rules 8-9), not
// computed. They self-check the oracle and are run against the implementation.

/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  CODEX,
  HUMAN,
  baseValue,
  candidate,
  ciValue,
  collected,
  evidence,
  ext,
  fail,
  key,
  ok,
  openRows,
  review,
  thread,
} from "./oracle";

const CLEAN_AT_HEAD = () => review("CLEAN_COMMENT", CODEX, "CLEAN", true);
const rv = (reviews: any[], threads: any[] = []) => ok({ reviews, threads });

export type HandCase = { id: string; clause: string; input: () => any; decision: string; reason?: string };

export const HAND_CASES: HandCase[] = [
  { id: "H01", clause: "§2 row 11", input: () => candidate(), decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  { id: "H02", clause: "§2 row 1", input: () => collected(evidence(key("MERGED", false), null)), decision: "NOT_OPEN" },
  { id: "H03", clause: "§2 row 1 before row 2", input: () => collected(evidence(key("CLOSED", true), null)), decision: "NOT_OPEN" },
  {
    id: "H04",
    clause: "§2 row 2 before every row; README rule 8",
    input: () =>
      collected(
        evidence(key("OPEN", true), {
          base: fail("base_ref"),
          ci: ok(ciValue("FAILED")),
          external: ok({ external: [ext("x", "failure")] }),
          reviews: fail("review_evidence_too_large"),
        }),
      ),
    decision: "DRAFT_HOLD",
  },
  {
    id: "H05",
    clause: "README rule 8: behind production reads NEEDS_REFRESH while history is unverified",
    input: () => candidate({ base: ok(baseValue(2)), ci: fail("base_history_unverified") }),
    decision: "NEEDS_REFRESH",
  },
  { id: "H06", clause: "§2 row 3 before row 4 (SPEC-05A A9)", input: () => candidate({ base: ok(baseValue(2)), ci: ok(ciValue("FAILED")) }), decision: "NEEDS_REFRESH" },
  { id: "H07", clause: "§2 row 3 failure reached first", input: () => candidate({ base: fail("base_ref"), ci: ok(ciValue("FAILED")) }), decision: "UNKNOWN", reason: "base_ref" },
  { id: "H08", clause: "§2 row 4 before row 5", input: () => candidate({ ci: ok(ciValue("FAILED")), external: fail("external_contexts_too_large") }), decision: "CI_FAILED" },
  {
    id: "H09",
    clause: "§2 row 4 failure before row 5",
    input: () => candidate({ ci: fail("shared_head"), external: ok({ external: [ext("x", "failure")] }) }),
    decision: "UNKNOWN",
    reason: "shared_head",
  },
  {
    id: "H10",
    clause: "§2 row 5 before row 9",
    input: () => candidate({ external: ok({ external: [ext("deploy", "failure")] }), reviews: fail("review_evidence_too_large") }),
    decision: "EXTERNAL_BLOCKED",
  },
  { id: "H11", clause: "§2 row 5 before row 6", input: () => candidate({ ci: ok(ciValue("NO_RUN")), external: ok({ external: [ext("deploy", "failure")] }) }), decision: "EXTERNAL_BLOCKED" },
  {
    id: "H12",
    clause: "§2 row 5 failure before row 6",
    input: () => candidate({ ci: ok(ciValue("NO_RUN")), external: fail("unrecognized_context_state") }),
    decision: "UNKNOWN",
    reason: "unrecognized_context_state",
  },
  { id: "H13", clause: "§2 row 6 before row 8", input: () => candidate({ ci: ok(ciValue("NO_RUN")), external: ok({ external: [ext("p", "pending")] }) }), decision: "CI_NOT_STARTED" },
  {
    id: "H14",
    clause: "§2 row 6 (README rule 9) before rows 8-9",
    input: () => candidate({ ci: ok(ciValue("INCOMPLETE")), external: ok({ external: [ext("p", "pending")] }), reviews: rv([]) }),
    decision: "CI_INCOMPLETE",
  },
  { id: "H15", clause: "§2 row 7 before row 8", input: () => candidate({ ci: ok(ciValue("PENDING")), external: ok({ external: [ext("p", "pending")] }) }), decision: "CI_PENDING" },
  { id: "H16", clause: "§2 row 7 before row 9", input: () => candidate({ ci: ok(ciValue("PENDING")), reviews: fail("malformed") }), decision: "CI_PENDING" },
  {
    id: "H17",
    clause: "§2 row 8 before row 9",
    input: () => candidate({ external: ok({ external: [ext("p", "pending")] }), reviews: fail("review_evidence_too_large") }),
    decision: "EXTERNAL_PENDING",
  },
  {
    id: "H18",
    clause: "§2 row 9 failure",
    input: () => candidate({ external: ok({ external: [ext("s", "success")] }), reviews: fail("review_evidence_too_large") }),
    decision: "UNKNOWN",
    reason: "review_evidence_too_large",
  },
  { id: "H19", clause: "§2 row 9", input: () => candidate({ reviews: rv([]) }), decision: "REVIEW_MISSING" },
  { id: "H20", clause: "§2 row 9 before row 10", input: () => candidate({ reviews: rv([], [thread(CODEX, false, null)]) }), decision: "REVIEW_MISSING" },
  { id: "H21", clause: "§3 channel A COMMENTED", input: () => candidate({ reviews: rv([review("PR_REVIEW", CODEX, "COMMENTED", true)]) }), decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  { id: "H22", clause: "§3 channel A APPROVED", input: () => candidate({ reviews: rv([review("PR_REVIEW", CODEX, "APPROVED", true)]) }), decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  { id: "H23", clause: "§3 FINDINGS_OPEN (ARCH-01 §18)", input: () => candidate({ reviews: rv([review("PR_REVIEW", CODEX, "CHANGES_REQUESTED", true)]) }), decision: "FINDINGS_OPEN" },
  {
    id: "H24",
    clause: "§3 CR at head with a clean comment",
    input: () => candidate({ reviews: rv([CLEAN_AT_HEAD(), review("PR_REVIEW", CODEX, "CHANGES_REQUESTED", true)]) }),
    decision: "FINDINGS_OPEN",
  },
  {
    id: "H25",
    clause: "§3 a stale CR is inert",
    input: () => candidate({ reviews: rv([CLEAN_AT_HEAD(), review("PR_REVIEW", CODEX, "CHANGES_REQUESTED", false)]) }),
    decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW",
  },
  { id: "H26", clause: "§3 clean never clears a thread (ARCH-01 §17B)", input: () => candidate({ reviews: rv([CLEAN_AT_HEAD()], [thread(CODEX, false, null)]) }), decision: "FINDINGS_OPEN" },
  { id: "H27", clause: "§3 resolved by the human resolver", input: () => candidate({ reviews: rv([CLEAN_AT_HEAD()], [thread(CODEX, true, HUMAN)]) }), decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  { id: "H28", clause: "§3 resolved by a non-allowlisted resolver", input: () => candidate({ reviews: rv([CLEAN_AT_HEAD()], [thread(CODEX, true, CODEX)]) }), decision: "FINDINGS_OPEN" },
  { id: "H29", clause: "§3 null resolver matches nothing", input: () => candidate({ reviews: rv([CLEAN_AT_HEAD()], [thread(CODEX, true, null)]) }), decision: "FINDINGS_OPEN" },
  {
    id: "H30",
    clause: "§3 resolver id AND type",
    input: () => candidate({ reviews: rv([CLEAN_AT_HEAD()], [thread(CODEX, true, { id: HUMAN.id, type: "Bot" })]) }),
    decision: "FINDINGS_OPEN",
  },
  {
    id: "H31",
    clause: "§3 opener id AND type",
    input: () => candidate({ reviews: rv([CLEAN_AT_HEAD()], [thread({ id: CODEX.id, type: "User" }, false, null)]) }),
    decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW",
  },
  { id: "H32", clause: "§3 a thread opened by anyone else never counts", input: () => candidate({ reviews: rv([CLEAN_AT_HEAD()], [thread(HUMAN, false, null)]) }), decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  { id: "H33", clause: "§3 outdated never matters", input: () => candidate({ reviews: rv([CLEAN_AT_HEAD()], [thread(CODEX, false, null, true)]) }), decision: "FINDINGS_OPEN" },
  { id: "H34", clause: "§3 type must match", input: () => candidate({ reviews: rv([review("CLEAN_COMMENT", { id: CODEX.id, type: "User" }, "CLEAN", true)]) }), decision: "REVIEW_MISSING" },
  { id: "H35", clause: "§3 id must match", input: () => candidate({ reviews: rv([review("CLEAN_COMMENT", { id: 12345, type: "Bot" }, "CLEAN", true)]) }), decision: "REVIEW_MISSING" },
  { id: "H36", clause: "§3 qualifiesAtHead", input: () => candidate({ reviews: rv([review("CLEAN_COMMENT", CODEX, "CLEAN", false)]) }), decision: "REVIEW_MISSING" },
  { id: "H37", clause: "§3 DISMISSED establishes nothing", input: () => candidate({ reviews: rv([review("PR_REVIEW", CODEX, "DISMISSED", true)]) }), decision: "REVIEW_MISSING" },
  { id: "H38", clause: "§3 PENDING establishes nothing", input: () => candidate({ reviews: rv([review("PR_REVIEW", CODEX, "PENDING", true)]) }), decision: "REVIEW_MISSING" },
  { id: "H39", clause: "§3 CLEAN on PR_REVIEW establishes nothing", input: () => candidate({ reviews: rv([review("PR_REVIEW", CODEX, "CLEAN", true)]) }), decision: "REVIEW_MISSING" },
  { id: "H40", clause: "§3 COMMENTED on CLEAN_COMMENT establishes nothing", input: () => candidate({ reviews: rv([review("CLEAN_COMMENT", CODEX, "COMMENTED", true)]) }), decision: "REVIEW_MISSING" },
  { id: "H41", clause: "§3 a null actor matches nothing", input: () => candidate({ reviews: rv([review("CLEAN_COMMENT", null, "CLEAN", true)]) }), decision: "REVIEW_MISSING" },
  { id: "H42", clause: "§3 a null id matches nothing", input: () => candidate({ reviews: rv([review("CLEAN_COMMENT", { id: null, type: "Bot" }, "CLEAN", true)]) }), decision: "REVIEW_MISSING" },
  {
    id: "H43",
    clause: "§1 collection failure",
    input: () => ({ ok: false, reason: "pr_key_moved", detail: "moved", stage: "confirm", diagnostics: {} }),
    decision: "UNKNOWN",
    reason: "pr_key_moved",
  },
  {
    id: "H44",
    clause: "§0 an open-set reason becomes malformed (wrong_base is ARCH-01's, not V1's)",
    input: () => ({ ok: false, reason: "wrong_base", detail: "x", stage: "collect", diagnostics: {} }),
    decision: "UNKNOWN",
    reason: "malformed",
  },
  { id: "H45", clause: "§0 open-set reason at a reached row", input: () => candidate({ ci: fail("ci_attestation_invalid") }), decision: "UNKNOWN", reason: "malformed" },
  { id: "H46", clause: "§2 external success never blocks", input: () => candidate({ external: ok({ external: [ext("Vercel", "success")] }) }), decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  {
    id: "H47",
    clause: "§2 row 5 before row 6 (INCOMPLETE)",
    input: () => candidate({ ci: ok(ciValue("INCOMPLETE")), external: ok({ external: [ext("deploy", "failure")] }) }),
    decision: "EXTERNAL_BLOCKED",
  },
  { id: "H48", clause: "§2 row 3 before row 6", input: () => candidate({ base: ok(baseValue(1)), ci: ok(ciValue("INCOMPLETE")) }), decision: "NEEDS_REFRESH" },
  { id: "H49", clause: "§2 row 1", input: () => collected(evidence(key("MERGED", false), null)), decision: "NOT_OPEN" },
  { id: "H50", clause: "§3 CHANGES_REQUESTED on CLEAN_COMMENT establishes nothing", input: () => candidate({ reviews: rv([review("CLEAN_COMMENT", CODEX, "CHANGES_REQUESTED", true)]) }), decision: "REVIEW_MISSING" },
  {
    id: "H51",
    clause: "§3 FINDINGS_OPEN needs a PR_REVIEW CR",
    input: () => candidate({ reviews: rv([CLEAN_AT_HEAD(), review("CLEAN_COMMENT", CODEX, "CHANGES_REQUESTED", true)]) }),
    decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW",
  },
  {
    id: "H52",
    clause: "§3 a CR from a non-Codex actor never counts",
    input: () => candidate({ reviews: rv([CLEAN_AT_HEAD(), review("PR_REVIEW", { id: CODEX.id, type: "User" }, "CHANGES_REQUESTED", true)]) }),
    decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW",
  },
  { id: "H53", clause: "§3 unresolved (resolver irrelevant)", input: () => candidate({ reviews: rv([CLEAN_AT_HEAD()], [thread(CODEX, false, HUMAN)]) }), decision: "FINDINGS_OPEN" },
  { id: "H54", clause: "§2 row 2 before a base failure", input: () => collected(evidence(key("OPEN", true), openRows({ base: fail("read_failed") }))), decision: "DRAFT_HOLD" },
  { id: "H55", clause: "§2 row 4 before a reviews failure", input: () => candidate({ ci: ok(ciValue("FAILED")), reviews: fail("read_failed") }), decision: "CI_FAILED" },
  // Pass 2 (SPEC-05B df8dd9b5 §1): closed enums, the evidence schema, positive run ids; malformed is row-scoped.
  {
    id: "H56",
    clause: "§1 verdict is a closed enum (pass 2)",
    input: () => candidate({ reviews: rv([CLEAN_AT_HEAD(), review("PR_REVIEW", CODEX, "changes_requested", true)]) }),
    decision: "UNKNOWN",
    reason: "malformed",
  },
  {
    id: "H57",
    clause: "§1 channel is a closed enum (pass 2)",
    input: () => candidate({ reviews: rv([CLEAN_AT_HEAD(), review("REVIEW_THREAD", CODEX, "CHANGES_REQUESTED", true)]) }),
    decision: "UNKNOWN",
    reason: "malformed",
  },
  {
    id: "H58",
    clause: "§1 evidence.schema must be eng-loop-v1/evidence@1 (pass 2)",
    input: () => {
      const c: any = candidate();
      c.evidence.schema = "eng-loop-v1/evidence@2";
      return c;
    },
    decision: "UNKNOWN",
    reason: "malformed",
  },
  {
    id: "H59",
    clause: "§1 the schema is read before row 1 (pass 2)",
    input: () => {
      const c: any = collected(evidence(key("MERGED", false), null));
      delete c.evidence.schema;
      return c;
    },
    decision: "UNKNOWN",
    reason: "malformed",
  },
  { id: "H60", clause: "§1 applicableRunIds are positive integers (pass 2)", input: () => candidate({ ci: ok(ciValue("FAILED", { applicableRunIds: [0] })) }), decision: "UNKNOWN", reason: "malformed" },
  {
    id: "H61",
    clause: "§1-§2 row 4 reads ci, so a bad applicableRunIds stops a SUCCEEDED path before candidacy (pass 2)",
    input: () => candidate({ ci: ok(ciValue("SUCCEEDED", { applicableRunIds: ["37673706298"] })) }),
    decision: "UNKNOWN",
    reason: "malformed",
  },
  {
    id: "H62",
    clause: "§1 row-scoped malformed: row 2 decides before row 9 reads the bad verdict (pass 2)",
    input: () => collected(evidence(key("OPEN", true), openRows({ reviews: rv([review("PR_REVIEW", CODEX, "BOGUS", true)]) }))),
    decision: "DRAFT_HOLD",
  },
  { id: "H63", clause: "§1 row-scoped malformed: row 3 before row 9 (pass 2)", input: () => candidate({ base: ok(baseValue(2)), reviews: rv([review("REVIEW_THREAD", CODEX, "CLEAN", true)]) }), decision: "NEEDS_REFRESH" },
  { id: "H64", clause: "§1 row-scoped malformed: row 4 before row 5 (pass 2)", input: () => candidate({ ci: ok(ciValue("FAILED")), external: ok({ external: [{ source: "x", state: "BOGUS" }] }) }), decision: "CI_FAILED" },
  {
    id: "H65",
    clause: "§1 row-scoped malformed: row 2 before row 4 (pass 2)",
    input: () => collected(evidence(key("OPEN", true), openRows({ ci: ok({ outcome: "BOGUS" }) }))),
    decision: "DRAFT_HOLD",
  },
  { id: "H66", clause: "§1 row-scoped malformed: row 5 before row 9 (pass 2)", input: () => candidate({ external: ok({ external: [ext("deploy", "failure")] }), reviews: rv([review("PR_REVIEW", CODEX, "approve", true)]) }), decision: "EXTERNAL_BLOCKED" },
  { id: "H67", clause: "§1 a closed verdict on the wrong channel still establishes nothing (pass 2)", input: () => candidate({ reviews: rv([review("CLEAN_COMMENT", CODEX, "APPROVED", true)]) }), decision: "REVIEW_MISSING" },
];
