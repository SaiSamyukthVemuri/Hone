import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Repeat-client fast charting — "Start from last session".
//
// Chloe's complaint: for a repeat client the chart made her preview what she
// already knew she did, confirm it, watch the panel close, wait for a refresh,
// scroll back down, and reopen the area before she could type today's minutes.
// The fast path collapses that to ONE interaction that lands her in today's
// editor.
//
// These are the STRUCTURAL guards: the fast path is a second ROUTE through the
// existing governed copy, never a second copy engine, and it may not invent
// today's clinical facts. Behaviour is proved in
// tests/db/repeat-client-fast-charting.db.test.ts and
// e2e/repeat-client-fast-charting.spec.ts.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
// Executable source only — line and block comments removed. Guards about what
// the UI SAYS must not be satisfied (or broken) by prose in a comment.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const BASE = "app/(app)/clients/[id]/sessions/[sessionId]";
const PANEL = read(`${BASE}/CopyPreviousAreasPanel.tsx`);
const ACTIONS = read(`${BASE}/whole-session-copy-actions.ts`);
const PAGE = read(`${BASE}/page.tsx`);
const VIEW = read(`${BASE}/session-blocks-view.tsx`);
const LANDING = read("lib/sessions/fast-chart-start.ts");
const NORMALIZE = read("lib/sessions/whole-session-copy-normalize.ts");
const MODEL = read("lib/sessions/whole-session-copy.ts");
const MIGRATION = read("supabase/migrations/0157_whole_session_copy_setup.sql");

// The fast path's own body, isolated so an assertion about it cannot be
// satisfied by unrelated code elsewhere in the panel.
const FAST = PANEL.slice(
  PANEL.indexOf("function startFromLastSession()"),
  PANEL.indexOf("function buildPreview()"),
);

describe("(1) an eligible repeat client is offered the fast path as the PRIMARY action", () => {
  it("the idle card leads with 'Start from last session'", () => {
    expect(PANEL).toMatch(/data-testid="copy-previous-fast-start"/);
    expect(PANEL).toMatch(/Start from last session/);
    expect(FAST.length).toBeGreaterThan(0);
  });

  it("the primary CTA appears BEFORE the preview CTA in the idle card", () => {
    const idle = PANEL.slice(PANEL.indexOf('if (phase === "idle")'));
    const fastCta = idle.indexOf('data-testid="copy-previous-fast-start"');
    const previewCta = idle.indexOf('data-testid="copy-previous-preview"');
    expect(fastCta).toBeGreaterThan(-1);
    expect(previewCta).toBeGreaterThan(-1);
    expect(fastCta).toBeLessThan(previewCta);
  });

  it("(18) the cautious PREVIEW path is RETAINED, with its testids and controls intact", () => {
    expect(PANEL).toMatch(/data-testid="copy-previous-preview"/);
    expect(PANEL).toMatch(/Preview first/);
    expect(PANEL).toMatch(/data-testid="copy-previous-preview-panel"/);
    expect(PANEL).toMatch(/data-testid="copy-previous-commit"/);
    expect(PANEL).toMatch(/data-testid="copy-previous-refresh"/);
    expect(PANEL).toMatch(/data-testid="copy-previous-cancel"/);
    expect(PANEL).toMatch(/<CopyDraftCard/);
  });

  it("the gate is unchanged: the panel still renders only on an EMPTY editable electrolysis chart", () => {
    expect(PAGE).toMatch(
      /!isFinalized &&\s*\n\s*session\.modality === "electrolysis" &&\s*\n\s*blockData &&\s*\n\s*blockData\.blocks\.length === 0 &&\s*\n\s*canCopyFromPrevious/,
    );
  });
});

describe("the idle card is HYDRATION-SAFE — it renders no runtime-locale date", () => {
  // Regression guard. Naming the source visit on the IDLE card put a date into
  // the SERVER-rendered pass for the first time: `toLocaleDateString(undefined,
  // …)` resolves to Node's locale on the server and the viewer's in the browser,
  // which is a React hydration mismatch on a clinical screen. The fr-CA charting
  // probe in e2e/point-of-care-memory.spec.ts caught it. The panel now renders
  // instants only through FormattedDateTime (SSR-empty + suppressHydrationWarning).
  it("the panel contains NO runtime-default locale formatting at all", () => {
    expect(PANEL).not.toMatch(/toLocaleDateString\(/);
    expect(PANEL).not.toMatch(/toLocaleString\(/);
    expect(PANEL).not.toMatch(/toLocaleTimeString\(/);
  });

  it("visit dates go through the shared instant renderer", () => {
    expect(PANEL).toMatch(/import \{ FormattedDateTime \} from "@\/components\/formatted-date-time"/);
    expect(PANEL).toMatch(/<FormattedDateTime iso=\{iso \?\? ""\} format="date" \/>/);
    // Both surfaces — the idle card and the preview header — use it.
    expect((PANEL.match(/<VisitDate iso=/g) ?? []).length).toBe(2);
  });

  it("the prose interpolates no date, so the server pass has no gap in a sentence", () => {
    const idle = PANEL.slice(
      PANEL.indexOf('if (phase === "idle")'),
      PANEL.indexOf('data-testid="copy-previous-fast-start"'),
    );
    expect(idle).not.toMatch(/\$\{visit\}|\{visit\}/);
  });
});

describe("(2) the fast path uses the AUTHORITATIVE previous session — never a browser choice", () => {
  it("it reads the source through the shared loader, which uses the server descriptor", () => {
    expect(FAST).toMatch(/await loadSource\(\)/);
    expect(PANEL).toMatch(
      /async function loadSource\(\)[\s\S]{0,400}?getWholeSessionCopySourceAction\(\{ clientId, sessionId \}\)/,
    );
    expect(ACTIONS).toMatch(/whole_session_copy_source_descriptor/);
  });

  it("the panel accepts NO source session id from anywhere — not a prop, not a param", () => {
    expect(PANEL).not.toMatch(/previousSessionId/);
    expect(PANEL).not.toMatch(/sourceSessionId\?:/); // never an inbound prop
    // The only props are the destination identity + a display-only date.
    expect(PANEL).toMatch(
      /clientId: string;\s*\n\s*sessionId: string;\s*\n[\s\S]{0,400}?sourceStartedAt\?: string \| null;/,
    );
  });

  it("it commits with the fingerprint the SERVER returned for that source", () => {
    expect(FAST).toMatch(/sourceSessionId: loaded\.sourceSessionId/);
    expect(FAST).toMatch(/sourceFingerprint: loaded\.sourceFingerprint/);
    // Never a browser-fabricated value.
    expect(FAST).not.toMatch(/sourceFingerprint: (""|null|crypto)/);
  });
});

describe("(3/4/5/6/7/8/9) reusable setup copies; today's clinical facts are NEVER manufactured", () => {
  it("the fast path sends the SAME canonical setup-only payload as the reviewed path", () => {
    // One commit helper, one mapper. The fast path passes drafts straight from
    // buildCopyDrafts — it constructs no payload of its own.
    expect(FAST).toMatch(/drafts: loaded\.drafts,/);
    expect(PANEL).toMatch(/drafts: env\.drafts\.map\(draftToCopyInput\)/);
    // Exactly ONE mapping call site — both routes share it.
    expect((PANEL.match(/\.map\(draftToCopyInput\)/g) ?? []).length).toBe(1);
    // The fast path does not map the payload itself.
    expect(FAST).not.toMatch(/draftToCopyInput/);
  });

  it("the fast path itself names NO clinical outcome field anywhere in its body", () => {
    // It cannot fabricate what it never mentions.
    expect(FAST).not.toMatch(
      /minutes|minutesPerformed|hairs|hairsTreated|tolerance|reaction|observationChips|observation_chips|comments|caution|numbing|aftercare|payment/i,
    );
  });

  it("(4) minutes performed is absent from the canonical client model AND the normalizer output", () => {
    expect(MODEL).not.toMatch(/minutesPerformed|minutes:/);
    // draftToCopyInput's setup literal carries no minutes key.
    const mapper = MODEL.slice(MODEL.indexOf("export function draftToCopyInput"));
    expect(mapper).not.toMatch(/minutes/i);
    // The normalizer accepts no minutes input and emits none.
    expect(NORMALIZE).not.toMatch(/minutes_performed:/);
    const setupInput = NORMALIZE.slice(
      NORMALIZE.indexOf("export type WholeSessionCopySetupInput"),
      NORMALIZE.indexOf("export type WholeSessionCopyDraftInput"),
    );
    expect(setupInput).not.toMatch(/minutes/i);
  });

  it("(5/6/7/8/9) the normalizer emits no hairs, reaction, tolerance, chips, notes, caution or numbing", () => {
    const emitted = NORMALIZE.slice(NORMALIZE.indexOf("const block: Record<string, unknown>"));
    for (const forbidden of [
      "hairs_treated",
      "reaction_type",
      "reaction_notes",
      "tolerance_rating",
      "observation_chips",
      "comments",
      "caution_for_next_session",
      "caution_note",
      "numbing_status",
      "numbing_notes",
      "block_name",
      "block_notes",
      "minutes_performed",
    ]) {
      expect(emitted).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("the RPC's INSERT allow-lists are the backstop — outcome columns are not writable by a copy", () => {
    const blockInsert = MIGRATION.slice(
      MIGRATION.indexOf("insert into public.session_blocks ("),
      MIGRATION.indexOf("returning id into v_block_id"),
    );
    for (const forbidden of [
      "minutes_performed",
      "tolerance_rating",
      "reaction_type",
      "reaction_notes",
      "caution_for_next_session",
      "caution_note",
      "numbing_status",
      "numbing_notes",
      "block_name",
      "block_notes",
    ]) {
      expect(blockInsert).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
    const entryInsert = MIGRATION.slice(
      MIGRATION.indexOf("insert into public.electrolysis_entries ("),
      MIGRATION.indexOf("end if;\n  end loop;"),
    );
    for (const forbidden of [
      "hairs_treated",
      "observation_chips",
      "comments",
      "minutes_performed",
      "probe_lot_id",
    ]) {
      expect(entryInsert).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });
});

describe("(10) source freshness is preserved — the fast path never silently copies stale setup", () => {
  it("a DEFINITIVE failure surfaces the mapped error and performs NO fallback write", () => {
    expect(FAST).toMatch(
      /if \(outcome\.kind === "failed"\) \{[\s\S]{0,400}?setError\(outcome\.error\);[\s\S]{0,80}?return;/,
    );
    // One submission per press — no automatic second attempt, no "force" flag.
    expect((FAST.match(/submitCommit\(/g) ?? []).length).toBe(1);
    expect(FAST).not.toMatch(/force|ignoreFingerprint/i);
  });

  it("the stale-source SQLSTATE still maps to a truthful, non-leaky message", () => {
    expect(ACTIONS).toMatch(/case "HN005":\s*\n\s*return "The previous visit changed\./);
  });

  it("the server action still REQUIRES the source identity + fingerprint before any write", () => {
    expect(ACTIONS).toMatch(/if \(!input\.sourceSessionId \|\| !input\.sourceFingerprint\)/);
  });
});

describe("(11) double submit cannot duplicate the copied setup", () => {
  it("a synchronous ref guard makes a same-tick double-click issue at most ONE request", () => {
    expect(PANEL).toMatch(/const fastInFlightRef = useRef\(false\)/);
    expect(FAST).toMatch(/if \(fastInFlightRef\.current\) return;/);
    expect(FAST).toMatch(/fastInFlightRef\.current = true;/);
    // Released in a finally, so a thrown/rejected attempt cannot wedge the button.
    expect(FAST).toMatch(/finally \{\s*\n\s*fastInFlightRef\.current = false;/);
  });

  it("the button is also disabled while the transition is pending", () => {
    expect(PANEL).toMatch(/const \[fastStarting, startFast\] = useTransition\(\)/);
    expect(PANEL).toMatch(
      /data-testid="copy-previous-fast-start"[\s\S]{0,200}?|disabled=\{busy\}[\s\S]{0,200}?data-testid="copy-previous-fast-start"/,
    );
    expect(PANEL).toMatch(/const busy = fastStarting \|\| loading;/);
  });

  // NOTE ON SCOPE: these are STRUCTURAL guards on the orchestration. They do not
  // by themselves prove that a lost response replays — that claim is only as good
  // as a run in which the write lands and the answer does not, which is
  // e2e/repeat-client-fast-charting.spec.ts, "a LOST COMMIT RESPONSE replays the
  // same governed request instead of re-reading the target".
  it("an UNKNOWN outcome is modelled distinctly from a definitive failure", () => {
    expect(PANEL).toMatch(/\| \{ kind: "unknown" \}/);
    expect(PANEL).toMatch(/\| \{ kind: "failed"; error: string \}/);
    expect(PANEL).toMatch(/kind: "committed"; createdBlockIds: string\[\]/);
    // A throw is UNKNOWN, never "failed" — the mapped result objects are the
    // only source of a definitive refusal.
    expect(PANEL).toMatch(/\} catch \{[\s\S]{0,240}?return \{ kind: "unknown" \};/);
  });

  it("an unknown outcome RETAINS the request envelope instead of discarding it", () => {
    expect(PANEL).toMatch(/const pendingRetryRef = useRef<RetryEnvelope \| null>\(null\)/);
    expect(PANEL).toMatch(
      /type RetryEnvelope = \{[\s\S]{0,260}?idempotencyKey: string;\s*\n\};/,
    );
    expect(FAST).toMatch(
      /if \(outcome\.kind === "unknown"\) \{[\s\S]{0,320}?pendingRetryRef\.current = env;[\s\S]{0,120}?setAmbiguous\(true\);/,
    );
  });

  it("a retry from the ambiguous state SKIPS the source read and re-submits the envelope", () => {
    // The defect: re-reading here reports not_empty once the first attempt has
    // landed, so the retry never reaches the retained key.
    expect(FAST).toMatch(
      /let env = pendingRetryRef\.current;\s*\n\s*if \(!env\) \{\s*\n\s*const loaded = await loadSource\(\);/,
    );
    // loadSource is reachable ONLY inside that `if (!env)` guard.
    const beforeCommit = FAST.slice(0, FAST.indexOf("const outcome = await submitCommit(env)"));
    expect((beforeCommit.match(/await loadSource\(\)/g) ?? []).length).toBe(1);
    expect(FAST).toMatch(/idempotencyKey: crypto\.randomUUID\(\)/); // minted per FRESH attempt only
  });

  it("any DEFINITIVE outcome clears the envelope, so there is no retry loop", () => {
    expect(FAST).toMatch(/pendingRetryRef\.current = null;\s*\n\s*setAmbiguous\(false\);/);
    // Nothing retries on its own — recovery is always a practitioner action.
    expect(FAST).not.toMatch(/setTimeout|setInterval|while \(|for \(/);
  });

  it("both success shapes land the same way, so a replay is as actionable as a first commit", () => {
    expect(PANEL).toMatch(/function landIn\(createdBlockIds: string\[\]\)/);
    expect(FAST).toMatch(/landIn\(outcome\.createdBlockIds\)/);
    // The landing does not branch on idempotentReplay — the ids are authoritative
    // either way.
    expect(FAST).not.toMatch(/idempotentReplay/);
  });

  it("the misleading 'nothing to copy' route is unreachable while an outcome is unknown", () => {
    // Previewing would re-read the source and report not_empty about a copy that
    // may have succeeded.
    expect(PANEL).toMatch(/disabled=\{busy \|\| ambiguous\}/);
    expect(PANEL).toMatch(/disabled=\{loading \|\| committing \|\| ambiguous\}/);
  });

  it("the ambiguous copy is TRUTHFUL — it never claims nothing was written", () => {
    expect(PANEL).toMatch(
      /const AMBIGUOUS_MESSAGE =\s*\n\s*"We couldn't confirm whether the setup was added\. Try again to check safely\.";/,
    );
    expect(PANEL).toMatch(/data-testid="copy-previous-ambiguous"/);
    // Scoped to EXECUTABLE source: the comments deliberately quote the false
    // claim they exist to warn against, and a comment must neither satisfy nor
    // break this guard.
    expect(stripComments(PANEL)).not.toMatch(/nothing was (saved|added|written)/i);
    expect(PANEL).toMatch(/"Try again to check"/);
  });

  it("the EDITABLE preview path keeps its per-build random key (its payload is not source-derived)", () => {
    expect(PANEL).toMatch(/setIdempotencyKey\(crypto\.randomUUID\(\)\)/);
    // The two key models are distinct: the preview never uses the source-keyed one.
    const preview = PANEL.slice(
      PANEL.indexOf("function buildPreview()"),
      PANEL.indexOf("function removeDraft("),
    );
    expect(preview).not.toMatch(/fastStartKey/);
  });

  it("it reuses the EXISTING 0157 ledger — no new persistence mechanism", () => {
    expect(MIGRATION).toMatch(
      /constraint session_copy_operations_idem_uniq unique \(target_session_id, idempotency_key\)/,
    );
    // The panel invents no storage of its own.
    expect(PANEL).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });
});

describe("(13) today's chart is never destructively replaced", () => {
  it("the RPC refuses a non-empty target, and the page hides the panel once areas exist", () => {
    expect(MIGRATION).toMatch(/raise exception 'target not empty' using errcode = 'HN003'/);
    expect(PAGE).toMatch(/blockData\.blocks\.length === 0/);
    expect(ACTIONS).toMatch(/case "HN003":/);
  });

  it("the fast path calls no removal/deletion surface at all", () => {
    // Named against the real destructive surfaces this screen has, rather than
    // the bare word "replace" — `router.replace` is a NAVIGATION, not a write.
    for (const destructive of [
      "removeSessionAreaAction",
      "deleteElectrolysisEntryAction",
      "deleteSession",
      "soft_delete",
      ".delete(",
      "truncate",
    ]) {
      expect(FAST).not.toContain(destructive);
    }
    // It performs no navigation of its own — landing is delegated to landIn().
    expect(FAST).not.toMatch(/router\./);
  });
});

describe("(19) after the copy she lands in TODAY'S editor — no close/refresh/scroll/reopen", () => {
  it("the fast path routes using the ids the RPC already returned (no schema change needed)", () => {
    expect(PANEL).toMatch(/const landing = landingBlockId\(createdBlockIds\)/);
    expect(PANEL).toMatch(/router\.replace\(fastChartUrl\(clientId, sessionId, landing\)\)/);
    expect(FAST).toMatch(/landIn\(outcome\.createdBlockIds\)/);
    // The commit action already surfaces them; nothing new was added to the DB.
    expect(ACTIONS).toMatch(/createdBlockIds: result\.created_block_ids \?\? \[\]/);
    expect(MIGRATION).toMatch(/'created_block_ids', to_jsonb\(v_ids\)/);
  });

  it("router.replace (not push) is used, so the copy leaves no extra history entry to back through", () => {
    const landFn = PANEL.slice(
      PANEL.indexOf("function landIn(createdBlockIds: string[])"),
      PANEL.indexOf("function startFromLastSession()"),
    );
    expect(landFn).toMatch(/router\.replace\(/);
    expect(landFn).not.toMatch(/router\.push\(/);
    expect(PANEL).not.toMatch(/router\.push\(/);
  });

  it("the page validates the landing id SERVER-side against this session's live blocks", () => {
    expect(PAGE).toMatch(/resolveAutoEditBlockId\(\s*\n?\s*query\[FAST_CHART_PARAM\]/);
    expect(PAGE).toMatch(/\.filter\(\(b\) => b\.deleted_at == null\)/);
    expect(LANDING).toMatch(/liveBlockIds\.includes\(candidate\)/);
  });

  it("the named area mounts already open, and scrolls itself into view", () => {
    expect(VIEW).toMatch(/const \[editing, setEditing\] = useState\(autoEdit\)/);
    expect(VIEW).toMatch(/sectionRef\.current\?\.scrollIntoView\(\{ block: "start" \}\)/);
    expect(VIEW).toMatch(/id=\{`area-\$\{block\.id\}`\}/);
    expect(VIEW).toMatch(/data-editing=\{editing \? "true" : "false"\}/);
  });

  it("the editor she lands in is the one-page form that owns TODAY'S facts", () => {
    // Editing an existing block renders BlockSetupForm with the block + its
    // first entry — the form that carries minutes, hairs, chips, tolerance and
    // notes. That is what makes the landing immediately actionable.
    expect(VIEW).toMatch(
      /\{editing \? \(\s*\n\s*<BlockSetupForm[\s\S]{0,400}?block=\{block\}[\s\S]{0,200}?firstEntry=\{entriesSorted\[0\] \?\? null\}/,
    );
  });

  it("the landing param is ONE-SHOT: consumed and cleared without a refetch", () => {
    expect(VIEW).toMatch(/url\.searchParams\.delete\(FAST_CHART_PARAM\)/);
    expect(VIEW).toMatch(/window\.history\.replaceState\(null, ""/);
    // Cleared shallowly — never via the router, which would re-render the tree.
    const effect = VIEW.slice(
      VIEW.indexOf("if (!autoEditBlockId || typeof window === \"undefined\") return;"),
      VIEW.indexOf("return (\n    <div className=\"flex flex-col gap-6\">"),
    );
    expect(effect).not.toMatch(/router\.|refresh\(|revalidate/);
  });
});

describe("(16/17) no new write surface, no migration", () => {
  it("the landing model is PURE — no I/O, no DB, no server action", () => {
    expect(LANDING).not.toMatch(/createClient|createAdminClient|\.rpc\(|\.from\(|use server|fetch\(/);
  });

  it("the fast path adds no direct DML and no second RPC", () => {
    expect(PANEL).not.toMatch(/\.from\(|\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
    expect((ACTIONS.match(/\.rpc\("copy_session_setup"/g) ?? []).length).toBe(1);
  });

  it("the commit action is still the registered service-role caller", () => {
    const allow = read("tests/security/service-role-allowlist.ts");
    expect(allow).toMatch(/whole-session-copy-actions\.ts/);
  });

  it("0157 is untouched applied history", () => {
    expect(MIGRATION).toMatch(/create or replace function public\.copy_session_setup\(/);
    expect(MIGRATION).toMatch(/^-- 0157: whole-session/);
  });
});
