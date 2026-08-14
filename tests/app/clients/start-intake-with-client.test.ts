import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// "Start intake with client": the Health & Forms entry point into the
// practitioner-assisted workflow.
//
// Section 1 is BEHAVIOURAL: the real server action runs against an in-memory
// fake implementing the PostgREST filter semantics it uses, with the existing
// creation helper spied on. A test that says "reused" is asserting the creation
// helper was genuinely never called.
//
// Sections 2-3 are SOURCE PINS for the button and the Health & Forms card,
// following the convention stated in tests/app/clients/intake-review-ui-state.ts:
// the unit lane runs `environment: "node"` and the repo ships no jsdom / RTL, so
// rendered behaviour is proven in the browser lane
// (e2e/practitioner-assisted-intake.spec.ts) and structure is pinned here.

type Row = Record<string, unknown>;

type DbState = {
  clients: Row[];
  intakes: Row[];
  failIntakeSelectWith?: { message: string; code?: string } | null;
};

function matches(r: Row, predicates: Array<(r: Row) => boolean>): boolean {
  return predicates.every((p) => p(r));
}

// Supports exactly the chain the action under test uses:
//   .select(cols).eq().is().eq().order().limit().maybeSingle()
// plus the .eq().maybeSingle() shape loadAuthorisedClient uses for `clients`.
function makeFakeSupabase(state: DbState) {
  function rowsFor(table: string): Row[] {
    if (table === "clients") return state.clients;
    if (table === "client_intake_forms") return state.intakes;
    if (table === "studios") return [{ id: "studio-1", name: "Test Studio" }];
    throw new Error(`fake supabase: unexpected table ${table}`);
  }

  function selectChain(table: string, cols: string) {
    const predicates: Array<(r: Row) => boolean> = [];
    let sortKey: string | null = null;
    let sortAsc = true;
    let cap: number | null = null;
    const chain = {
      eq(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return chain;
      },
      is(col: string, val: unknown) {
        predicates.push((r) => r[col] === val);
        return chain;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        sortKey = col;
        sortAsc = opts?.ascending !== false;
        return chain;
      },
      limit(n: number) {
        cap = n;
        return chain;
      },
      async maybeSingle() {
        if (table === "client_intake_forms" && state.failIntakeSelectWith) {
          const err = state.failIntakeSelectWith;
          state.failIntakeSelectWith = null;
          return { data: null, error: err };
        }
        let found = rowsFor(table).filter((r) => matches(r, predicates));
        if (sortKey) {
          const key = sortKey;
          found = [...found].sort((a, b) => {
            const av = String(a[key] ?? "");
            const bv = String(b[key] ?? "");
            return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (cap !== null) found = found.slice(0, cap);
        if (found.length > 1) {
          return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
        }
        if (found.length === 0) return { data: null, error: null };
        const projection = cols.split(",").map((c) => c.trim());
        return {
          data: Object.fromEntries(projection.map((c) => [c, found[0][c]])) as Row,
          error: null,
        };
      },
    };
    return chain;
  }

  return {
    from(table: string) {
      return { select: (cols: string) => selectChain(table, cols) };
    },
  };
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const STUDIO = "studio-1";
const CLIENT = "client-1";
const OTHER_CLIENT = "client-2";
const PRAC = "prac-a";
const NEW_INTAKE = "intake-new";
const OPEN_INTAKE = "intake-open";

const state: DbState = { clients: [], intakes: [], failIntakeSelectWith: null };

const {
  createClientSpy,
  createAdminClientSpy,
  getCurrentPractitionerWithStudio,
  revalidatePath,
  createIntakeRequestForClient,
  generateIntakeLinkUrl,
  stampIntakeLinkIssued,
  sendIntakeUpdateRequestToClient,
  limitPractitionerClientEmail,
} = vi.hoisted(() => ({
  createClientSpy: vi.fn(),
  createAdminClientSpy: vi.fn(),
  getCurrentPractitionerWithStudio: vi.fn(),
  revalidatePath: vi.fn(),
  createIntakeRequestForClient: vi.fn(),
  generateIntakeLinkUrl: vi.fn(),
  stampIntakeLinkIssued: vi.fn(),
  sendIntakeUpdateRequestToClient: vi.fn(),
  limitPractitionerClientEmail: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientSpy }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: createAdminClientSpy,
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio,
  getPractitionersForStudio: vi.fn(),
}));
vi.mock("@/lib/intake/queries", () => ({
  createIntakeRequestForClient,
  generateIntakeLinkUrl,
  stampIntakeLinkIssued,
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: () => "https://app.example.test",
}));
vi.mock("@/lib/rate-limit/public", () => ({ limitPractitionerClientEmail }));
vi.mock("@/lib/email/send-appointment", () => ({
  sendIntakeUpdateRequestToClient,
}));

import { startAssistedIntakeAction } from "@/app/(app)/clients/[id]/intake/actions";

function intakeRow(over: Partial<Row> = {}): Row {
  return {
    id: OPEN_INTAKE,
    studio_id: STUDIO,
    client_id: CLIENT,
    status: "in_progress",
    deleted_at: null,
    created_at: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

function fd(clientId: string = CLIENT, extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("client_id", clientId);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

function asPractitioner(active = true) {
  getCurrentPractitionerWithStudio.mockResolvedValue({
    practitioner: {
      id: PRAC,
      active,
      display_name: "Chloe Baca",
      email: "chloe@x.test",
    },
    studio: { id: STUDIO },
  });
}

beforeEach(() => {
  state.clients = [
    { id: CLIENT, studio_id: STUDIO, name: "Dana", email: "dana@example.test" },
  ];
  state.intakes = [];
  state.failIntakeSelectWith = null;
  revalidatePath.mockClear();
  createClientSpy.mockReset();
  createClientSpy.mockImplementation(async () => makeFakeSupabase(state));
  createAdminClientSpy.mockReset();
  createAdminClientSpy.mockReturnValue({});
  createIntakeRequestForClient.mockReset();
  createIntakeRequestForClient.mockResolvedValue({
    id: NEW_INTAKE,
    url: "https://app.example.test/intake/tok-secret",
  });
  generateIntakeLinkUrl.mockReset();
  generateIntakeLinkUrl.mockReturnValue("https://app.example.test/intake/tok-secret");
  stampIntakeLinkIssued.mockReset();
  stampIntakeLinkIssued.mockResolvedValue(undefined);
  sendIntakeUpdateRequestToClient.mockReset();
  sendIntakeUpdateRequestToClient.mockResolvedValue({ ok: true });
  limitPractitionerClientEmail.mockReset();
  limitPractitionerClientEmail.mockResolvedValue({ allowed: true });
  getCurrentPractitionerWithStudio.mockReset();
  asPractitioner();
});

// ---------------------------------------------------------------------------
describe("1. starting an intake with the client present", () => {
  it("creates one blank intake and returns its id", async () => {
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.intakeId).toBe(NEW_INTAKE);
    // Exactly one creation, through the EXISTING helper.
    expect(createIntakeRequestForClient).toHaveBeenCalledTimes(1);
    expect(createIntakeRequestForClient).toHaveBeenCalledWith(
      expect.objectContaining({ studioId: STUDIO, clientId: CLIENT }),
    );
  });

  it("sends NO email: the client is standing in the room", async () => {
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(true);
    // The email itself is never sent...
    expect(sendIntakeUpdateRequestToClient).not.toHaveBeenCalled();
    // ...and the row is stamped as NOT emailed, so the link status the
    // practitioner later sees does not claim a send that never happened.
    expect(stampIntakeLinkIssued).toHaveBeenCalledWith(expect.anything(), NEW_INTAKE, {
      emailed: false,
    });
  });

  it("does not even consult the client-email rate limiter", async () => {
    // requestIntakeUpdateAction only rate-limits when it is about to email.
    // A limiter call would therefore mean send_email had gone true.
    await startAssistedIntakeAction(fd());
    expect(limitPractitionerClientEmail).not.toHaveBeenCalled();
  });

  it("a browser-supplied send_email cannot turn the email back on", async () => {
    // The action reads no email flag from its own FormData; it pins "false"
    // when delegating. A crafted payload must not change that.
    const res = await startAssistedIntakeAction(fd(CLIENT, { send_email: "true" }));
    expect(res.ok).toBe(true);
    expect(sendIntakeUpdateRequestToClient).not.toHaveBeenCalled();
    expect(limitPractitionerClientEmail).not.toHaveBeenCalled();
  });

  it("returns the intake id and NOT the client's tokenized URL", async () => {
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The bearer link the creation helper minted must not reach the browser
    // through this path, the practitioner is going to the authenticated
    // assisted route, and the hand-off owns the token.
    expect(res).not.toHaveProperty("intakeUrl");
    expect(JSON.stringify(res)).not.toContain("tok-secret");
    expect(JSON.stringify(res)).not.toContain("/intake/");
  });
});

// ---------------------------------------------------------------------------
describe("2. duplicate safety", () => {
  it("reuses an existing in-progress intake instead of creating a second", async () => {
    state.intakes = [intakeRow()];
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.intakeId).toBe(OPEN_INTAKE);
    expect(createIntakeRequestForClient).not.toHaveBeenCalled();
  });

  it("two sequential clicks produce ONE intake, not two", async () => {
    const first = await startAssistedIntakeAction(fd());
    expect(first.ok).toBe(true);
    // The first click's row now exists, exactly as the database would have it.
    state.intakes = [intakeRow({ id: NEW_INTAKE })];
    const second = await startAssistedIntakeAction(fd());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.intakeId).toBe(NEW_INTAKE);
    expect(createIntakeRequestForClient).toHaveBeenCalledTimes(1);
  });

  it("picks the newest in-progress row when the client somehow has two", async () => {
    state.intakes = [
      intakeRow({ id: "older", created_at: "2026-07-01T10:00:00.000Z" }),
      intakeRow({ id: "newer", created_at: "2026-08-05T10:00:00.000Z" }),
    ];
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.intakeId).toBe("newer");
  });

  it("a submitted or reviewed record is not reused, a fresh one is created", async () => {
    for (const status of ["submitted", "reviewed"]) {
      createIntakeRequestForClient.mockClear();
      state.intakes = [intakeRow({ status })];
      const res = await startAssistedIntakeAction(fd());
      expect(res.ok, status).toBe(true);
      if (!res.ok) continue;
      // The clinical record is never rewritten; a new blank row is the
      // correction model, exactly as Send a new intake form already works.
      expect(res.intakeId, status).toBe(NEW_INTAKE);
      expect(createIntakeRequestForClient, status).toHaveBeenCalledTimes(1);
    }
  });

  it("a soft-deleted in-progress row is not reused", async () => {
    state.intakes = [intakeRow({ deleted_at: "2026-08-01T00:00:00.000Z" })];
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.intakeId).toBe(NEW_INTAKE);
  });

  it("another client's in-progress row is not reused", async () => {
    state.clients.push({
      id: OTHER_CLIENT,
      studio_id: STUDIO,
      name: "Someone else",
      email: null,
    });
    state.intakes = [intakeRow({ client_id: OTHER_CLIENT })];
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.intakeId).toBe(NEW_INTAKE);
  });

  it("another studio's in-progress row is not reused", async () => {
    state.intakes = [intakeRow({ studio_id: "studio-other" })];
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.intakeId).toBe(NEW_INTAKE);
  });
});

// ---------------------------------------------------------------------------
describe("3. authorization", () => {
  it("an inactive practitioner is denied and nothing is created", async () => {
    asPractitioner(false);
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(false);
    expect(createIntakeRequestForClient).not.toHaveBeenCalled();
  });

  it("a practitioner from another studio is denied", async () => {
    getCurrentPractitionerWithStudio.mockResolvedValue({
      practitioner: { id: "prac-b", active: true, display_name: "Other", email: "o@x" },
      studio: { id: "studio-other" },
    });
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(false);
    expect(createIntakeRequestForClient).not.toHaveBeenCalled();
  });

  it("an absent client is denied", async () => {
    const res = await startAssistedIntakeAction(fd("client-nope"));
    expect(res.ok).toBe(false);
    expect(createIntakeRequestForClient).not.toHaveBeenCalled();
  });

  it("a missing client id is denied", async () => {
    const res = await startAssistedIntakeAction(new FormData());
    expect(res.ok).toBe(false);
    expect(createIntakeRequestForClient).not.toHaveBeenCalled();
  });

  it("the studio and client ids come from the SESSION, never the payload", async () => {
    const crafted = fd(CLIENT, {
      studio_id: "studio-evil",
      practitioner_id: "prac-evil",
      requested_by: "prac-evil",
    });
    const res = await startAssistedIntakeAction(crafted);
    expect(res.ok).toBe(true);
    const args = createIntakeRequestForClient.mock.calls[0][0];
    expect(args.studioId).toBe(STUDIO);
    expect(args.clientId).toBe(CLIENT);
    expect(args.requestedBy).toBe(PRAC);
    expect(JSON.stringify(args)).not.toContain("evil");
  });
});

// ---------------------------------------------------------------------------
describe("4. failure behaviour", () => {
  it("a refused creation returns an error and no intake id", async () => {
    createIntakeRequestForClient.mockResolvedValue(null);
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(false);
    expect(res).not.toHaveProperty("intakeId");
  });

  it("a lookup failure returns curated copy, never provider text", async () => {
    state.failIntakeSelectWith = {
      message: "permission denied for relation client_intake_forms",
      code: "42501",
    };
    const res = await startAssistedIntakeAction(fd());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).not.toMatch(/permission denied|relation|42501|PGRST/i);
    expect(res.error).toMatch(/Please try again/);
    expect(createIntakeRequestForClient).not.toHaveBeenCalled();
  });

  it("no refusal names a token, a URL, or a database object", async () => {
    const refusals: string[] = [];
    asPractitioner(false);
    let r = await startAssistedIntakeAction(fd());
    if (!r.ok) refusals.push(r.error);
    asPractitioner();
    r = await startAssistedIntakeAction(fd("client-nope"));
    if (!r.ok) refusals.push(r.error);
    createIntakeRequestForClient.mockResolvedValue(null);
    r = await startAssistedIntakeAction(fd());
    if (!r.ok) refusals.push(r.error);

    expect(refusals.length).toBeGreaterThanOrEqual(3);
    for (const m of refusals) {
      expect(m).not.toMatch(/token|http|client_intake_forms|studio_id|deleted_at/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Source pins, the button and the Health & Forms card.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
// Strip // line comments and {/* jsx */} blocks so negative greps target real
// code, not prose that legitimately names a forbidden shape.
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const BUTTON = read("app/(app)/clients/[id]/intake/StartAssistedIntakeButton.tsx");
const BUTTON_CODE = codeOnly(BUTTON);
const PROFILE = read("app/(app)/clients/[id]/page.tsx");
const PROFILE_CODE = codeOnly(PROFILE);
const ACTIONS_CODE = codeOnly(read("app/(app)/clients/[id]/intake/actions.ts"));

describe("5. the button", () => {
  it("carries the exact CTA copy", () => {
    expect(BUTTON_CODE).toContain("Start intake with client");
  });

  it("shows a pending label and disables itself while creating", () => {
    expect(BUTTON_CODE).toMatch(/disabled=\{isPending\}/);
    expect(BUTTON_CODE).toMatch(
      /\{isPending \? "Starting\.\.\." : "Start intake with client"\}/,
    );
  });

  it("latches synchronously so a double click cannot fire twice", () => {
    expect(BUTTON_CODE).toMatch(/const inFlight = useRef\(false\)/);
    expect(BUTTON_CODE).toMatch(/if \(inFlight\.current\) return;/);
    expect(BUTTON_CODE).toMatch(/inFlight\.current = true;/);
    // Exactly one release site, and it is in a `finally`. Releasing only on
    // the refusal path would leave the latch shut forever if the action threw
    // rather than returned, the button would look enabled and be inert.
    expect(BUTTON_CODE.match(/inFlight\.current = false/g) ?? []).toHaveLength(1);
    expect(BUTTON_CODE).toMatch(
      /\} finally \{[\s\S]{0,300}?if \(!navigating\) inFlight\.current = false;/,
    );
    // ...and it is NOT released when we are navigating away on success.
    expect(BUTTON_CODE).toMatch(/navigating = true;[\s\S]{0,140}?router\.push/);
  });

  it("an action that faults outright is caught, not left hanging", () => {
    expect(BUTTON_CODE).toMatch(/\} catch \{/);
    const caught = BUTTON_CODE.slice(
      BUTTON_CODE.indexOf("} catch {"),
      BUTTON_CODE.indexOf("} finally {"),
    );
    expect(caught).toMatch(/setError\(UNEXPECTED_FAILURE\)/);
    // A fault is not a reason to navigate.
    expect(caught).not.toMatch(/router\./);
    // ...and the fallback copy names no provider detail.
    expect(BUTTON_CODE).toMatch(
      /const UNEXPECTED_FAILURE =\s*\n?\s*"Could not start an intake for this client\. Please try again\.";/,
    );
  });

  it("navigates to the AUTHENTICATED assisted route, using the returned id", () => {
    expect(BUTTON_CODE).toMatch(
      /router\.push\(\s*`\/clients\/\$\{clientId\}\/intake\/assist\?intake=\$\{res\.intakeId\}`\s*\)/,
    );
  });

  it("never navigates to the client's tokenized intake route", () => {
    // The public route is /intake/<token>. Nothing in this component may
    // build it, and the action gives it no URL to build one from.
    expect(BUTTON_CODE).not.toMatch(/intakeUrl/);
    expect(BUTTON_CODE).not.toMatch(/router\.(push|replace)\(\s*`?\/intake\//);
    expect(BUTTON_CODE).not.toMatch(/window\.location/);
  });

  it("does not navigate when the server refuses", () => {
    const handler = BUTTON_CODE.slice(
      BUTTON_CODE.indexOf("function start()"),
      BUTTON_CODE.indexOf("return ("),
    );
    const refusal = handler.slice(
      handler.indexOf("if (!res.ok)"),
      handler.indexOf("router.push"),
    );
    expect(refusal).toMatch(/setError\(res\.error\)/);
    expect(refusal).toMatch(/return;/);
    expect(refusal).not.toMatch(/router\./);
  });

  it("renders the server's curated message, never a raw error object", () => {
    expect(BUTTON_CODE).toMatch(/role="alert"/);
    expect(BUTTON_CODE).toMatch(/\{error\}/);
    expect(BUTTON_CODE).not.toMatch(/error\.message|JSON\.stringify|String\(err/);
  });

  it("creates nothing optimistically in browser state", () => {
    expect(BUTTON_CODE).not.toMatch(/useOptimistic/);
    expect(BUTTON_CODE).not.toMatch(/setIntake|localStorage|sessionStorage/);
  });

  it("meets the house touch target", () => {
    expect(BUTTON_CODE).toMatch(/min-h-\[44px\]/);
  });
});

// One status branch of the Health intake card, sliced from its own gate to the
// next sibling gate or the close of the section. Slicing on the bare
// `{intake?.status === "submitted" &&` marker would land on the STATUS PILL at
// the top of the card and swallow every branch below it, which is how an
// earlier version of this test passed while asserting nothing.
function healthBranch(gate: string): string {
  const start = PROFILE_CODE.indexOf(gate);
  expect(start, `gate not found: ${gate}`).toBeGreaterThan(-1);
  const rest = PROFILE_CODE.slice(start + gate.length);
  const stops = [
    rest.indexOf("{intake?.status"),
    rest.indexOf("{!intake"),
    rest.indexOf("</section>"),
  ].filter((i) => i > -1);
  return rest.slice(0, stops.length ? Math.min(...stops) : rest.length);
}

describe("6. the Health & Forms card", () => {
  it("renders the CTA only in the no-intake branch", () => {
    expect(PROFILE_CODE).toMatch(
      /\{!intake && \([\s\S]{0,600}?<StartAssistedIntakeButton clientId=\{client\.id\} \/>/,
    );
  });

  it("no other conditional gate stands between !intake and the CTA", () => {
    const btn = PROFILE_CODE.indexOf("<StartAssistedIntakeButton");
    expect(btn).toBeGreaterThan(-1);
    const gate = PROFILE_CODE.lastIndexOf("{!intake && (", btn);
    expect(gate, "the CTA must sit under a !intake gate").toBeGreaterThan(-1);
    const between = PROFILE_CODE.slice(gate, btn);
    expect(between).not.toMatch(/\{intake\?\.status/);
    expect(between).not.toMatch(/\{intake && /);
  });

  it("there is exactly one Start intake with client control", () => {
    expect(PROFILE_CODE.match(/<StartAssistedIntakeButton/g) ?? []).toHaveLength(1);
  });

  it("the submitted branch offers no start control", () => {
    const branch = healthBranch(
      '{intake?.status === "submitted" && intake.submitted_at && (',
    );
    expect(branch).toContain("View intake");
    expect(branch).not.toContain("StartAssistedIntakeButton");
  });

  it("the reviewed branch offers no start control", () => {
    const branch = healthBranch(
      '{intake?.status === "reviewed" && intake.reviewed_at && (',
    );
    expect(branch).toContain("View intake");
    expect(branch).not.toContain("StartAssistedIntakeButton");
  });

  it("the in-progress branch is unchanged, resend, not create", () => {
    const branch = healthBranch('{intake?.status === "in_progress" && (');
    expect(branch).toContain("<IntakeResendCard");
    expect(branch).not.toContain("StartAssistedIntakeButton");
    expect(branch).not.toContain("startAssistedIntakeAction");
  });

  it("the no-intake copy names the client", () => {
    expect(PROFILE).toMatch(/No intake on file for this client\./);
  });
});

describe("7. the action reuses creation rather than re-implementing it", () => {
  const body = ACTIONS_CODE.slice(
    ACTIONS_CODE.indexOf("export async function startAssistedIntakeAction"),
  );

  it("delegates to the existing reissue action", () => {
    expect(body).toMatch(/await requestIntakeUpdateAction\(fd\)/);
  });

  it("inserts nothing itself and mints no token", () => {
    expect(body).not.toMatch(/\.insert\(/);
    expect(body).not.toMatch(/createIntakeRequestForClient/);
    expect(body).not.toMatch(/generateIntakeLinkUrl|generateIntakeToken/);
    expect(body).not.toMatch(/createAdminClient/);
  });

  it("pins send_email to false, and reads no email flag of its own", () => {
    expect(body).toMatch(/fd\.set\("send_email", "false"\)/);
    expect(body).not.toMatch(/formData\.get\("send_email"\)/);
  });

  it("returns no URL to the browser", () => {
    expect(body).not.toMatch(/intakeUrl:/);
    expect(ACTIONS_CODE).toMatch(
      /export type StartAssistedIntakeResult =\s*\|\s*\{ ok: true; intakeId: string \}/,
    );
  });

  it("returns no raw provider text", () => {
    expect(body).not.toMatch(/error:\s*[a-zA-Z]*[eE]rr(or)?\.message/);
    expect(body).toMatch(/START_NOT_PERMITTED|START_DB_FAILURE/);
  });
});
