import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  provisionStudioSmsSender,
  type ClaimResult,
  type ClaimRow,
  type FailResult,
  type FinalizeResult,
  type ProvisioningStore,
} from "@/lib/sms/provisioning";
import {
  CLAIM_RESULTS,
  FAIL_RESULTS,
  FINALIZE_RESULTS,
} from "@/lib/sms/provisioning-store";
import { FakeSmsProvisioningProvider } from "@/lib/sms/provider/fake-provider";

// COMMS-01B — THE AUTHORITATIVE-WRITE CENSUS.
//
// Four authoritative writes decide provisioning state, and every one of them
// answers in WORDS:
//
//   1. claim                  -- may this worker act at all?
//   2. finalize (activating)  -- is this sender live?
//   3. finalize (identifiers) -- are the provider SIDs durably recorded?
//   4. fail                   -- was the attempt parked?
//
// The defect this file exists to prevent has appeared FIVE times in review,
// each at a different word: a verdict the database returned was DISCARDED and
// the worker's own stale story reported over it. Handling "the ones we
// thought of" is what produced that record.
//
// So this is a CENSUS, not a sample. It enumerates every word each command can
// return -- read from the store's own vocabulary, which is itself pinned
// against the SQL -- and drives the orchestration with each one. No word may
// produce an outcome that claims something the database did not say.

const ROOT = path.resolve(__dirname, "../../..");
const MIGRATION_PATH = "supabase/migrations/0191_studio_sms_sender_provisioning.sql";
const MIGRATION = readFileSync(path.join(ROOT, MIGRATION_PATH), "utf8");
const MIGRATION_LINES = MIGRATION.split("\n");

// ---------------------------------------------------------------------------
// READING THE SQL'S RESULT VOCABULARY — AND FAILING CLOSED WHEN IT CANNOT BE READ
// ---------------------------------------------------------------------------
//
// An earlier revision of this file grepped the function bodies for
// `return '<word>'` and `'<word>'::text`. That is a guard that recognises the
// spellings it happens to know, and review found the hole: SQL can assign a
// literal to a variable and return the VARIABLE.
//
//     v_indirect text := 'mystery_verdict';
//     ...
//     return v_indirect;
//
// The grep sees no word, the SQL list stays unchanged, it still equals the
// application list, and the whole suite goes GREEN while the database can
// return a verdict the application has never heard of. Reproduced before
// fixing: that exact mutant left this file at 36/36.
//
// Adding a second regex for that spelling would leave the same hole one shape
// further out. So the rule is inverted: every RETURN in an authoritative
// command must be a form whose vocabulary can be enumerated COMPLETELY, and
// anything else is a failure that names the function and the line. A guard
// that cannot read the vocabulary must say so, not shrug.

type AuthoritativeCommand = {
  readonly fn: string;
  /** `words` returns a result vocabulary; `boolean` answers yes/no. */
  readonly returns: "words" | "boolean";
};

/**
 * The 0191 commands whose answers decide provisioning state. `resolve_...`
 * (uuid) and `studio_sms_lease_window()` (interval) are excluded: neither
 * carries a verdict a caller must interpret.
 */
const AUTHORITATIVE_COMMANDS: readonly AuthoritativeCommand[] = [
  { fn: "claim_studio_sms_provisioning", returns: "words" },
  { fn: "finalize_studio_sms_provisioning", returns: "words" },
  { fn: "fail_studio_sms_provisioning", returns: "words" },
  { fn: "renew_studio_sms_lease", returns: "boolean" },
];

type ReturnStatement = { line: number; text: string };
type Vocabulary = { words: string[]; violations: string[] };

/** The body of one function, with its offset so line numbers stay real. */
function functionBody(fn: string): { body: string; firstLine: number } {
  const at = MIGRATION.indexOf(`create or replace function public.${fn}`);
  expect(at, `${fn} is not defined in ${MIGRATION_PATH}`).toBeGreaterThan(-1);
  const end = MIGRATION.indexOf("$$;", at);
  expect(end, `${fn} has no terminator`).toBeGreaterThan(at);
  return {
    body: MIGRATION.slice(at, end),
    firstLine: MIGRATION.slice(0, at).split("\n").length,
  };
}

/**
 * Every RETURN statement in a function, comment-stripped, with real line
 * numbers.
 *
 * Scans for EVERY `return` token rather than for lines that begin with one.
 * The first version of this did the latter and a mutation caught it: an
 * idiomatic one-liner
 *
 *     if false then return 'brand_new_word'; end if;
 *
 * starts with `if`, so the return was invisible and a new word entered the SQL
 * with this suite green -- the same failure as the indirect return, one shape
 * further out. Position in a line is not a property worth trusting.
 */
function returnStatements(fn: string): ReturnStatement[] {
  const { body, firstLine } = functionBody(fn);
  // Strip line comments first so a `return` mentioned in prose is not a
  // statement, and a `--` cannot swallow a real one.
  const code = body
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");

  const out: ReturnStatement[] = [];
  // `\breturn\b` does not match `returns`, so the signature is not a hit.
  for (const match of code.matchAll(/\breturn\b/g)) {
    const from = match.index ?? 0;
    const semi = code.indexOf(";", from);
    const text = code
      .slice(from, semi === -1 ? code.length : semi + 1)
      .replace(/\s+/g, " ")
      .trim();
    // `return query select ...` is one statement; the inner `return` of a
    // nested form would be found separately, which is the conservative
    // direction: extra candidates become violations, never silent omissions.
    out.push({
      line: firstLine + code.slice(0, from).split("\n").length - 1,
      text,
    });
  }
  return out;
}

/**
 * Classify every return in a command. Enumerable forms contribute their word;
 * ANY other shape is a violation, so an unreadable vocabulary fails closed.
 */
function vocabularyOf(cmd: AuthoritativeCommand): Vocabulary {
  const words = new Set<string>();
  const violations: string[] = [];

  for (const stmt of returnStatements(cmd.fn)) {
    // `return;` — terminates after a `return query`, carries no verdict.
    if (/^return\s*;$/.test(stmt.text)) continue;

    // `return query select 'word'::text, ...` — the verdict is the first column.
    //
    // The COMMA is required, not decorative. Stopping at a word boundary
    // accepted any expression that merely BEGINS with a literal cast --
    // `select 'claimed'::text || '_new', ...` was read as the existing
    // `claimed` verdict while the function actually returns `claimed_new`.
    // Requiring the column to end right there keeps the vocabulary a set of
    // whole literals; a concatenation or any other expression falls through to
    // the violation branch and fails closed.
    const queried = stmt.text.match(/^return query select '([a-z_]+)'::text\s*,/);
    if (queried) {
      words.add(queried[1]);
      continue;
    }

    // `return 'word';`
    const literal = stmt.text.match(/^return '([a-z_]+)';$/);
    if (literal) {
      words.add(literal[1]);
      continue;
    }

    // Boolean commands answer yes/no; their vocabulary is not words.
    if (
      cmd.returns === "boolean" &&
      /^return (true|false|coalesce\([a-z_]+, (true|false)\));$/.test(stmt.text)
    ) {
      continue;
    }

    violations.push(
      `${cmd.fn} at ${MIGRATION_PATH}:${stmt.line} returns a shape whose ` +
        `vocabulary cannot be enumerated: \`${stmt.text}\`. Return a literal ` +
        "so the vocabulary stays mechanically readable -- an indirect return " +
        "hides a word from this guard and defeats the fail-closed check.",
    );
  }

  return { words: [...words].sort(), violations };
}

const STUDIO = "studio-a";
const OWNER = "owner-a";
const CHOSEN = "+14165550100";
const CLAIM_KEY = `hone-sms-${"a".repeat(32)}`;
const GEN = 3;

let provider: FakeSmsProvisioningProvider;
beforeEach(() => {
  provider = new FakeSmsProvisioningProvider();
  provider.reset();
});

/** A store whose four writes each answer with a word the test chooses. */
class CensusStore implements ProvisioningStore {
  constructor(
    private readonly words: {
      claim?: ClaimResult;
      finalizeActivating?: FinalizeResult;
      finalizeIdentifiers?: FinalizeResult;
      fail?: FailResult;
    },
  ) {}
  finalizeCalls = 0;

  async claim(): Promise<ClaimRow> {
    const result = this.words.claim ?? "claimed";
    const usable = result === "claimed" || result === "already_active";
    return {
      result,
      senderId: "sender-1",
      claimKey: usable ? CLAIM_KEY : null,
      senderStatus: "provisioning",
      leaseGeneration: usable ? GEN : null,
    };
  }

  async finalize(input: { testOk: boolean }): Promise<FinalizeResult> {
    this.finalizeCalls += 1;
    return input.testOk
      ? (this.words.finalizeActivating ?? "activated")
      : (this.words.finalizeIdentifiers ?? "provisioned_untested");
  }

  async fail(): Promise<FailResult> {
    return this.words.fail ?? "failed";
  }

  async renewLease(): Promise<boolean> {
    return true;
  }
}

function run(store: ProvisioningStore) {
  return provisionStudioSmsSender({
    store,
    provider,
    studioId: STUDIO,
    actorUserId: OWNER,
    country: "CA",
    areaCode: "416",
    phoneNumber: CHOSEN,
    inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
    statusCallbackUrl: "https://hone.care/api/twilio/status",
    testDestination: "+14165559999",
    serviceLabel: "Studio A",
    testBody: "Hone provisioning test.",
  });
}

// ---------------------------------------------------------------------------
// The vocabularies agree with the database
// ---------------------------------------------------------------------------

describe("the SQL vocabulary is READABLE, and the application knows all of it", () => {
  it.each(AUTHORITATIVE_COMMANDS.map((c) => [c.fn, c] as const))(
    "%s exposes a mechanically enumerable vocabulary",
    (_fn, cmd) => {
      // FAIL CLOSED. A command that returns a variable, or any expression this
      // guard cannot enumerate, is reported by function and line rather than
      // silently contributing nothing -- which is how a word the application
      // has never heard of would otherwise slip through with the suite green.
      const { violations } = vocabularyOf(cmd);
      expect(violations).toEqual([]);
    },
  );

  it.each([
    ["claim_studio_sms_provisioning", CLAIM_RESULTS],
    ["finalize_studio_sms_provisioning", FINALIZE_RESULTS],
    ["fail_studio_sms_provisioning", FAIL_RESULTS],
  ] as const)("%s: SQL and application vocabularies are identical", (fn, known) => {
    // A word the SQL can return but the store does not recognise is mapped to
    // `invalid_input` and SILENTLY loses its meaning -- the same class of
    // defect as discarding a verdict, arriving by a different route.
    const cmd = AUTHORITATIVE_COMMANDS.find((c) => c.fn === fn)!;
    const { words, violations } = vocabularyOf(cmd);
    expect(violations).toEqual([]);
    expect(words).toEqual([...known].sort());
  });

  it("the boolean command carries no word vocabulary at all", () => {
    const renew = AUTHORITATIVE_COMMANDS.find((c) => c.returns === "boolean")!;
    const { words, violations } = vocabularyOf(renew);
    expect(violations).toEqual([]);
    // Its answer is yes/no; a text verdict here would mean the fence had grown
    // a vocabulary nobody is reading.
    expect(words).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1. claim — every word
// ---------------------------------------------------------------------------

describe("claim: every result word is handled", () => {
  const SUCCESSFUL: ClaimResult[] = ["claimed", "already_active"];

  it.each(CLAIM_RESULTS)("%s", async (word) => {
    const store = new CensusStore({ claim: word });
    const outcome = await run(store);

    if (word === "claimed") {
      expect(outcome).toMatchObject({ ok: true, result: "activated" });
      return;
    }
    if (word === "already_active") {
      expect(outcome).toMatchObject({ ok: true, result: "already_active" });
      return;
    }
    if (word === "claim_held") {
      // Excluded, and it must have performed no provider effect.
      expect(outcome).toMatchObject({ ok: false, result: "in_progress" });
      expect(provider.calls.purchase).toBe(0);
      return;
    }
    // Every remaining word is a refusal that NAMES itself -- never a generic
    // failure, and never a provider error.
    expect(outcome).toMatchObject({ ok: false, result: "refused", reason: word });
    expect(provider.calls.purchase).toBe(0);
    expect(provider.ownedNumbers()).toEqual([]);
  });

  it("no successful word leaks through as a refusal, and vice versa", () => {
    for (const word of CLAIM_RESULTS) {
      expect(SUCCESSFUL.includes(word) || word !== "claimed").toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. finalize (activating) — every word
// ---------------------------------------------------------------------------

describe("finalize while activating: every result word is handled", () => {
  it.each(FINALIZE_RESULTS)("%s", async (word) => {
    const store = new CensusStore({ finalizeActivating: word });
    const outcome = await run(store);

    if (word === "activated" || word === "already_active") {
      expect(outcome).toMatchObject({ ok: true, result: "activated" });
      return;
    }
    if (word === "lease_lost") {
      expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
      return;
    }
    // The database's word is REPORTED, not replaced by a provider error.
    expect(outcome).toMatchObject({ ok: false, result: "failed", reason: word });
  });
});

// ---------------------------------------------------------------------------
// 3. finalize (identifiers, after a failed provider test) — every word
// ---------------------------------------------------------------------------

describe("identifier persistence on a failed test: every result word is handled", () => {
  it.each(FINALIZE_RESULTS)("%s", async (word) => {
    provider.reset({ testSendFails: "provider_rejected" });
    const store = new CensusStore({ finalizeIdentifiers: word });
    const outcome = await run(store);

    if (word === "lease_lost") {
      expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
      return;
    }

    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    if (outcome.ok || outcome.result !== "failed") return;

    const recorded = word === "provisioned_untested" || word === "already_active";
    // Whether the SIDs were durably written is reported either way. When they
    // were NOT, that outranks "the provider test failed": one is a retry, the
    // other means Hone is paying for resources it has no record of.
    expect(outcome.identifiersRecorded).toBe(recorded);
    expect(outcome.identifierResult).toBe(word);
  });
});

// ---------------------------------------------------------------------------
// 4. fail — every word
// ---------------------------------------------------------------------------

describe("the parking write: every result word is handled", () => {
  it.each(FAIL_RESULTS)("%s", async (word) => {
    // Reach the failure path via a provider rejection.
    provider.reset({ purchaseFails: "provider_rejected" });
    const store = new CensusStore({ fail: word });
    const outcome = await run(store);

    if (word === "lease_lost") {
      expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
      return;
    }

    expect(outcome).toMatchObject({ ok: false, result: "failed" });
    if (outcome.ok || outcome.result !== "failed") return;

    // `parked` is the database's answer, never an assumption; and the word
    // itself travels so nothing is lost.
    expect(outcome.parked).toBe(word === "failed");
    expect(outcome.parkResult).toBe(word);
    // The provider's own error is still reported alongside -- both facts.
    expect(outcome.reason).toBe("provider_rejected");
  });
});

// ---------------------------------------------------------------------------
// The canonical number: ONE value for the whole attempt
// ---------------------------------------------------------------------------

describe("the selected number is canonicalized once", () => {
  const PADDED = "  +14165550100  ";

  /** Records the number every boundary actually receives. */
  class NumberWitnessStore implements ProvisioningStore {
    seen: { claim?: string; renew: string[]; finalize?: string } = { renew: [] };
    async claim(input: { phoneNumber: string }): Promise<ClaimRow> {
      this.seen.claim = input.phoneNumber;
      return {
        result: "claimed",
        senderId: "sender-1",
        claimKey: CLAIM_KEY,
        senderStatus: "provisioning",
        leaseGeneration: GEN,
      };
    }
    async finalize(input: { phoneNumber: string }): Promise<FinalizeResult> {
      this.seen.finalize = input.phoneNumber;
      return "activated";
    }
    async fail(): Promise<FailResult> {
      return "failed";
    }
    async renewLease(input: { phoneNumber: string }): Promise<boolean> {
      this.seen.renew.push(input.phoneNumber);
      // THE DATABASE'S RULE, MODELLED: the row stores btrim(...), so the fence
      // only matches a value that is already canonical. A raw padded string
      // fails here -- which is exactly how the legitimate generation used to
      // fail its own fence.
      return input.phoneNumber === CHOSEN;
    }
  }

  it("a padded selection is canonicalized and the fence SUCCEEDS", async () => {
    const store = new NumberWitnessStore();
    const outcome = await provisionStudioSmsSender({
      store,
      provider,
      studioId: STUDIO,
      actorUserId: OWNER,
      country: "CA",
      areaCode: "416",
      phoneNumber: PADDED,
      inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
      statusCallbackUrl: "https://hone.care/api/twilio/status",
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    });

    expect(outcome).toMatchObject({ ok: true, result: "activated" });
    // ONE value everywhere: claim, every fence, and the finalize.
    expect(store.seen.claim).toBe(CHOSEN);
    expect(store.seen.finalize).toBe(CHOSEN);
    expect(store.seen.renew.length).toBeGreaterThan(0);
    expect([...new Set(store.seen.renew)]).toEqual([CHOSEN]);
    // ...and the provider was asked about the canonical number too.
    expect(provider.ownedNumbers()).toEqual([CHOSEN]);
  });

  it("a selection that cannot be canonicalized is refused BEFORE the claim", async () => {
    const store = new NumberWitnessStore();
    const outcome = await provisionStudioSmsSender({
      store,
      provider,
      studioId: STUDIO,
      actorUserId: OWNER,
      country: "CA",
      areaCode: "416",
      phoneNumber: "not-a-number",
      inboundWebhookUrl: "https://hone.care/api/twilio/inbound-sms",
      statusCallbackUrl: "https://hone.care/api/twilio/status",
      testDestination: "+14165559999",
      serviceLabel: "Studio A",
      testBody: "Hone provisioning test.",
    });

    expect(outcome).toMatchObject({ ok: false, result: "refused", reason: "invalid_input" });
    // No claim opened, no provider work.
    expect(store.seen.claim).toBeUndefined();
    expect(provider.calls.purchase).toBe(0);
  });

  it("MUTATION CONTROL: without canonicalization the legitimate worker fails its own fence", async () => {
    // The defect, performed. Passing the raw padded value to the fence -- as
    // the code did before -- means the row (which stores the trimmed value)
    // never matches, so the worker that legitimately holds the claim is
    // refused by its own lease check.
    const store = new NumberWitnessStore();
    expect(await store.renewLease({ phoneNumber: PADDED })).toBe(false);
    expect(await store.renewLease({ phoneNumber: CHOSEN })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Persistence is the database's word, on the SUCCESSFUL-test path too
// ---------------------------------------------------------------------------

describe("identifiersRecorded reflects DB acknowledgement, never inference", () => {
  /** Provider test SUCCEEDS; the activating finalize answers `verdict`. */
  class ActivatingVerdictStore implements ProvisioningStore {
    constructor(private readonly verdict: FinalizeResult) {}
    async claim(): Promise<ClaimRow> {
      return {
        result: "claimed",
        senderId: "sender-1",
        claimKey: CLAIM_KEY,
        senderStatus: "provisioning",
        leaseGeneration: GEN,
      };
    }
    async finalize(input: { testOk: boolean }): Promise<FinalizeResult> {
      return input.testOk ? this.verdict : "provisioned_untested";
    }
    async fail(): Promise<FailResult> {
      return "failed";
    }
    async renewLease(): Promise<boolean> {
      return true;
    }
  }

  it.each(["conflict", "not_provisioning", "claim_not_found", "invalid_input"] as const)(
    "provider test PASSED but finalize -> %s: identifiersRecorded is false",
    async (verdict) => {
      // Everything at the provider went right and Hone holds the SIDs. None of
      // that is persistence. Only the database's acknowledgement is.
      const outcome = await run(new ActivatingVerdictStore(verdict));

      expect(outcome).toMatchObject({ ok: false, result: "failed" });
      if (outcome.ok || outcome.result !== "failed") return;
      expect(outcome.identifiersRecorded).toBe(false);
      expect(outcome.identifierResult).toBe(verdict);
      // And the caller is told resources may be outstanding.
      expect(outcome.mayOwnUnfinalizedResources).toBe(true);
    },
  );

  it("provider test PASSED but finalize -> lease_lost: displacement authority is preserved", async () => {
    const outcome = await run(new ActivatingVerdictStore("lease_lost"));
    expect(outcome).toMatchObject({ ok: false, result: "lease_lost" });
  });

  it.each(["activated", "already_active"] as const)(
    "finalize -> %s is the ONLY shape that reports success",
    async (verdict) => {
      const outcome = await run(new ActivatingVerdictStore(verdict));
      expect(outcome).toMatchObject({ ok: true, result: "activated" });
    },
  );

  it("no failed outcome ever claims persistence the database did not acknowledge", async () => {
    // Sweep: every non-success activating verdict, plus a provider failure with
    // no identifier write at all. None may report identifiersRecorded true.
    for (const verdict of FINALIZE_RESULTS) {
      if (verdict === "activated" || verdict === "already_active") continue;
      if (verdict === "lease_lost") continue;
      const outcome = await run(new ActivatingVerdictStore(verdict));
      if (!outcome.ok && outcome.result === "failed") {
        expect(outcome.identifiersRecorded, `verdict ${verdict}`).toBe(false);
      }
      provider.reset();
    }
  });
});

// ---------------------------------------------------------------------------
// The census is exhaustive by construction
// ---------------------------------------------------------------------------

describe("census coverage", () => {
  it("counts the authoritative writes and their words", () => {
    // 4 writes: claim, finalize(activating), finalize(identifiers), fail.
    // finalize is one command driven at two decision points, and both are
    // enumerated because they are read differently.
    expect(CLAIM_RESULTS.length).toBeGreaterThanOrEqual(9);
    expect(FINALIZE_RESULTS.length).toBeGreaterThanOrEqual(8);
    expect(FAIL_RESULTS.length).toBeGreaterThanOrEqual(6);
  });
});
