import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// EMERG-PORTAL-REBOOK-01 — the identity boundary, pinned at the source.
// ===========================================================================
//
// The whole unit rests on one property: the returning client's identity comes
// from the portal session and from NOWHERE ELSE. The dormant unauthenticated
// path in app/book/[slug]/actions.ts binds `client_type=existing` by matching a
// TYPED email against an active client, which is an impersonation surface. This
// action must never grow that shape, and the public UI must never start
// offering the old one.
//
// A browser assertion cannot see this. An action that quietly read
// `formData.get("email")` would render identically right up until someone used
// it, and a behavioural test would need the attacker's exact request to notice.
// So it is checked in the source — and EVERY "does not contain" rule below
// carries a NEGATIVE CONTROL, because a forbidden-pattern rule that matches
// nothing passes on an empty file.

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

const ACTION_REL = "app/portal/rebook-actions.ts";
const FORM_REL = "app/portal/PortalRebookCard.tsx";
const PORTAL_PAGE_REL = "app/portal/page.tsx";
const PUBLIC_FORM_REL = "app/book/[slug]/PublicBookForm.tsx";

const RAW = read(ACTION_REL);

// LINE comments are stripped BEFORE block comments. A `//` line containing `/*`
// would otherwise leave the block stripper eating real code to the next `*/`,
// and every assertion below would be vacuously true. This file's own prose
// names `email`, `client_type` and the dormant path when explaining what it
// refuses to do, so prose must neither satisfy nor trip a source rule.
const codeOnly = (source: string) =>
  source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");

const CODE = codeOnly(RAW);
const FORM_CODE = codeOnly(read(FORM_REL));

describe("the comment stripper itself", () => {
  it("keeps code and drops prose", () => {
    expect(CODE).toContain("export async function bookAnotherAppointmentAction");
    // This sentence exists only inside a comment in the action.
    expect(RAW).toContain("It never supplies WHO");
    expect(CODE).not.toContain("It never supplies WHO");
  });

  it("does not eat code that follows a line comment containing a block opener", () => {
    const sample = ["// a note with /* inside it", "const kept = 1;"].join("\n");
    expect(codeOnly(sample)).toContain("const kept = 1;");
  });
});

// ---------------------------------------------------------------------------
// Identity comes from the session, never from the form.
// ---------------------------------------------------------------------------

/**
 * Any assignment to `clientId` that is NOT the one blessed binding.
 *
 * `test()` on a /g regex advances `lastIndex`, so this is declared without the
 * global flag and used one call at a time.
 */
const REASSIGNED_CLIENT_ID = /\bclientId\s*=(?!\s*session\.clientId\b)/;

/** Every shape that would let a caller name WHO they are. */
const SUBMITTED_IDENTITY = [
  /formData\.get\(\s*["']email["']\s*\)/,
  /formData\.get\(\s*["']clientId["']\s*\)/,
  /formData\.get\(\s*["']client_id["']\s*\)/,
  /formData\.get\(\s*["']studioId["']\s*\)/,
  /formData\.get\(\s*["']studio_id["']\s*\)/,
  /formData\.get\(\s*["']name["']\s*\)/,
  /formData\.get\(\s*["']phone["']\s*\)/,
  /formData\.get\(\s*["']slug["']\s*\)/,
  /formData\.get\(\s*["']clientType["']\s*\)/,
  /formData\.get\(\s*["']client_type["']\s*\)/,
];

describe("identity comes from the session, never from the form", () => {
  for (const shape of SUBMITTED_IDENTITY) {
    it(`never reads ${String(shape)}`, () => {
      expect(CODE).not.toMatch(shape);
    });
  }

  it("resolves the session before it reads anything submitted", () => {
    const session = CODE.indexOf("getCurrentPortalSession");
    const firstForm = CODE.indexOf("formData.get");
    expect(session).toBeGreaterThan(-1);
    expect(firstForm).toBeGreaterThan(-1);
    expect(
      session,
      "the session must be resolved before any submitted value is read, so a " +
        "refusal cannot depend on submitted data",
    ).toBeLessThan(firstForm);
  });

  it("takes both identity values straight off the session object", () => {
    expect(CODE).toMatch(/const\s+studioId\s*=\s*session\.studioId\s*;/);
    expect(CODE).toMatch(/const\s+clientId\s*=\s*session\.clientId\s*;/);
  });

  it("passes the SESSION's ids to the commit", () => {
    expect(CODE).toMatch(/p_studio_id:\s*studio\.id\b/);
    expect(CODE).toMatch(/p_client_id:\s*clientId\b/);
    // `clientId` must not be reassigned anywhere after the session set it.
    //
    // The lookahead sits IMMEDIATELY after `=` and swallows the whitespace
    // itself. Written as `\\s*=\\s*(?!session\\.clientId)` the trailing `\\s*` can
    // backtrack to zero width, so the lookahead is evaluated at the SPACE
    // before `session` — where the forbidden text does not start — and the rule
    // fires on the one binding it is meant to bless.
    expect(REASSIGNED_CLIENT_ID.test(CODE)).toBe(false);
  });

  it("NEGATIVE CONTROL: the rebinding rule fires on a real rebinding", () => {
    expect(REASSIGNED_CLIENT_ID.test(`clientId = formData.get("clientId");`)).toBe(true);
    expect(REASSIGNED_CLIENT_ID.test(`let clientId = winner.id;`)).toBe(true);
    // ...and stays silent on the blessed binding.
    expect(REASSIGNED_CLIENT_ID.test(`const clientId = session.clientId;`)).toBe(false);
  });

  it("scopes the client lookup by BOTH the session client and the session studio", () => {
    expect(CODE).toMatch(/\.eq\("id",\s*clientId\)/);
    expect(CODE).toMatch(/\.eq\("studio_id",\s*studioId\)/);
  });

  it("the form supplies ONLY choices", () => {
    const reads = [
      ...CODE.matchAll(/formData\.get\(\s*["']([a-zA-Z_]+)["']\s*\)/g),
    ].map((m) => m[1]);
    expect(reads.length).toBeGreaterThan(0);
    expect(
      [...new Set(reads)].sort(),
      "serviceId and startsAt are the choices; notes is the existing booking " +
        "contract's own optional note. Nothing else may be read.",
    ).toEqual(["notes", "serviceId", "startsAt"]);
  });

  it("the BROWSER sends only those three fields too", () => {
    const sent = [...FORM_CODE.matchAll(/fd\.set\(\s*["']([a-zA-Z_]+)["']/g)].map(
      (m) => m[1],
    );
    expect(sent.length).toBeGreaterThan(0);
    expect([...new Set(sent)].sort()).toEqual(["notes", "serviceId", "startsAt"]);
  });

  describe("the guards are not vacuous", () => {
    it("SUBMITTED_IDENTITY fires on the shape it forbids", () => {
      const forged = [
        `const email = formData.get("email");`,
        `const clientId = formData.get("clientId");`,
        `const studioId = formData.get("studio_id");`,
      ].join("\n");
      const fired = SUBMITTED_IDENTITY.filter((p) => p.test(forged));
      expect(fired.length).toBeGreaterThanOrEqual(3);
    });

    it("none of them fires on the shipped action", () => {
      for (const shape of SUBMITTED_IDENTITY) {
        expect(CODE, String(shape)).not.toMatch(shape);
      }
    });

    it("the ordering rule fails when the session is resolved late", () => {
      const inverted = codeOnly(
        [`const x = formData.get("serviceId");`, `await getCurrentPortalSession();`].join(
          "\n",
        ),
      );
      expect(inverted.indexOf("getCurrentPortalSession")).toBeGreaterThan(
        inverted.indexOf("formData.get"),
      );
    });

    it("the allowed-field rule fails when a fourth field is read", () => {
      const widened = codeOnly(
        [
          `formData.get("serviceId");`,
          `formData.get("startsAt");`,
          `formData.get("notes");`,
          `formData.get("email");`,
        ].join("\n"),
      );
      const reads = [
        ...widened.matchAll(/formData\.get\(\s*["']([a-zA-Z_]+)["']\s*\)/g),
      ].map((m) => m[1]);
      expect([...new Set(reads)].sort()).not.toEqual([
        "notes",
        "serviceId",
        "startsAt",
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// The commit goes through the locked command.
// ---------------------------------------------------------------------------

describe("the commit goes through the canonical command, not a raw insert", () => {
  it("calls create_public_appointment", () => {
    expect(CODE).toMatch(/\.rpc\(\s*\n?\s*["']create_public_appointment["']/);
  });

  it("never inserts into appointments directly", () => {
    // The command writes the MANDATORY appointment_audit row in the same
    // transaction. A direct insert here would reintroduce the exact defect
    // migration 0170 exists to close.
    const forbidden = /from\(\s*["']appointments["']\s*\)[\s\S]{0,200}\.insert\(/;
    expect(CODE).not.toMatch(forbidden);
    // NEGATIVE CONTROL.
    expect(`admin.from("appointments").insert({ starts_at })`).toMatch(forbidden);
  });

  it("requests no duration, end time, status, practitioner or override", () => {
    const FORBIDDEN_PARAMS = [
      /p_duration/,
      /p_ends_at/,
      /p_end_time/,
      /p_status/,
      /p_override/,
      /p_practitioner_id/,
      /p_slot_verified/,
    ];
    for (const forbidden of FORBIDDEN_PARAMS) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden);
    }
    // NEGATIVE CONTROL: the patterns do match the shapes they name.
    const bad = `p_duration: 60, p_status: "confirmed", p_practitioner_id: x`;
    expect(FORBIDDEN_PARAMS.filter((p) => p.test(bad)).length).toBeGreaterThanOrEqual(3);
  });

  it("adds no migration dependency of its own", () => {
    // The command already accepted p_client_id and already validated it. The
    // emergency needed a caller, not new schema — and a source rule is what
    // keeps a later edit honest.
    const forbidden = /create_portal_appointment|p_portal_/;
    expect(CODE).not.toMatch(forbidden);
    expect(`admin.rpc("create_portal_appointment", {})`).toMatch(forbidden);
  });
});

// ---------------------------------------------------------------------------
// It does not reopen, or depend on, the unauthenticated path.
// ---------------------------------------------------------------------------

describe("it does not reopen the unauthenticated existing-client path", () => {
  it("imports nothing from the public booking route", () => {
    const forbidden = /from\s+["']@\/app\/book\//;
    expect(CODE).not.toMatch(forbidden);
    expect(`import { x } from "@/app/book/[slug]/actions";`).toMatch(forbidden);
  });

  it("never sends or reads a client_type", () => {
    expect(CODE).not.toMatch(/client_type/);
    expect(FORM_CODE).not.toMatch(/client_type/);
  });

  it("never consults the new-client waitlist ADMISSION gate", () => {
    // WAIT gates whether a visitor presenting nothing may be admitted as a NEW
    // client. A returning client with a live session was admitted long ago and
    // is not re-admitted here, so this file must not be able to refuse one.
    const forbidden = /isNewClientWaitlistEnabled|new-client-waitlist|NEW_CLIENT_WAITLIST/;
    expect(CODE).not.toMatch(forbidden);
    expect(
      `import { isNewClientWaitlistEnabled } from "@/lib/booking/new-client-waitlist";`,
    ).toMatch(forbidden);
  });

  it("never consults an invitation, scope or capability", () => {
    const forbidden = /invitation_token|invitation_capability|authorizeInvitationForBooking/;
    expect(CODE).not.toMatch(forbidden);
    expect(`const t = formData.get("invitation_token");`).toMatch(forbidden);
  });
});

// ---------------------------------------------------------------------------
// L. The PUBLIC unauthenticated existing-client binding stays unreachable.
// ---------------------------------------------------------------------------

describe("L. the public existing-client email-binding path remains unreachable", () => {
  const PUBLIC_FORM = read(PUBLIC_FORM_REL);

  it("the existing-client choice still early-returns to the portal", () => {
    const branch = PUBLIC_FORM.indexOf('if (clientType === "existing") {');
    expect(branch, "the early return must still exist").toBeGreaterThan(-1);
    const tail = PUBLIC_FORM.slice(branch, branch + 3000);
    expect(tail).toContain("/portal/login");
  });

  it("that early return happens BEFORE the booking form can be rendered", () => {
    const branch = PUBLIC_FORM.indexOf('if (clientType === "existing") {');
    const bookingForm = PUBLIC_FORM.indexOf("onSubmit={submit}");
    expect(bookingForm).toBeGreaterThan(-1);
    expect(
      branch,
      "an existing-client visitor must return before the submitting form exists",
    ).toBeLessThan(bookingForm);
  });

  it("NEGATIVE CONTROL: the ordering check fails when the early return is gone", () => {
    const mutated = PUBLIC_FORM.replace('if (clientType === "existing") {', "if (false) {");
    expect(mutated.indexOf('if (clientType === "existing") {')).toBe(-1);
  });

  it("the portal never points a client back at the public existing-client form", () => {
    const portalPage = read(PORTAL_PAGE_REL);
    expect(portalPage).not.toMatch(/href=\{?["'`]\/book\//);
    expect(FORM_CODE).not.toMatch(/\/book\//);
  });
});

// ---------------------------------------------------------------------------
// M. Rebooking is a CAPABILITY, not a task. It must not depend on paperwork.
// ---------------------------------------------------------------------------

describe("M. the booking door renders independently of the pending-actions zone", () => {
  const portalPage = read(PORTAL_PAGE_REL);

  it("the portal offers 'Book another appointment' at all", () => {
    expect(portalPage).toContain("PortalRebookCard");
    expect(read(FORM_REL)).toContain("Book another appointment");
  });

  it("the card is rendered BEFORE the Needs-you branch, so it is outside it", () => {
    // The Needs-you zone is one `{hasNeedsYou ? ( ... ) : ( ... )}` expression.
    // Anything that appears before it in the source cannot be inside it — which
    // is the whole of the P1: an established client with nothing outstanding
    // has hasNeedsYou === false, sees "You're all caught up", and must still be
    // able to book.
    const card = portalPage.indexOf("<PortalRebookCard");
    const needsYou = portalPage.indexOf("{hasNeedsYou ?");
    expect(card).toBeGreaterThan(-1);
    expect(needsYou).toBeGreaterThan(-1);
    expect(
      card,
      "the rebooking card must not sit inside the pending-actions branch",
    ).toBeLessThan(needsYou);
  });

  it("`hasNeedsYou` does not gate the rebooking section at all", () => {
    // The section wrapping the card branches on read-failure and on an empty
    // service list, and on nothing else.
    const card = portalPage.indexOf("<PortalRebookCard");
    const section = portalPage.lastIndexOf("<section", card);
    const around = portalPage.slice(section, card);
    expect(around).not.toContain("hasNeedsYou");
    expect(around).toContain("rebookReadFailed");
    expect(around).toContain("rebookServices.length === 0");
  });

  it("NEGATIVE CONTROL: the placement rule fires when the card moves inside", () => {
    // Reproduce the shipped defect and prove the assertion catches it.
    const defective = portalPage.replace("<PortalRebookCard", "<PortalRebookCardMoved");
    const moved = `${defective}\n<PortalRebookCard services={x} />`;
    expect(moved.indexOf("<PortalRebookCard services")).toBeGreaterThan(
      moved.indexOf("{hasNeedsYou ?"),
    );
  });

  it("a failed read and an empty menu are DIFFERENT states", () => {
    // "We couldn't ask" must never be rendered as "this studio offers nothing".
    expect(portalPage).toContain("portal-rebook-unavailable");
    expect(portalPage).toContain("portal-rebook-no-services");
    const unavailable = portalPage.indexOf("portal-rebook-unavailable");
    const around = portalPage.slice(unavailable - 400, unavailable + 300);
    expect(around).not.toMatch(/isn.t taking online bookings/);
  });

  it("the card is handed a service menu and a date window, never an identity", () => {
    const card = portalPage.indexOf("<PortalRebookCard");
    const props = portalPage.slice(card, portalPage.indexOf("/>", card));
    expect(props).toContain("services=");
    expect(props).toContain("minDate=");
    expect(props).toContain("maxDate=");
    expect(props).not.toMatch(/clientId|client_id|clientEmail|session\./);
  });
});

// ---------------------------------------------------------------------------
// P1-1. The service menu, the validation and the duration are ONE read.
// ---------------------------------------------------------------------------

describe("P1-1. services come from the portal-authorized admin read", () => {
  const portalPage = read(PORTAL_PAGE_REL);
  const queries = read("lib/portal/queries.ts");

  it("neither the action nor the page uses the RLS-bound getActiveServices", () => {
    // It reads through the ordinary client, whose scope is a PRACTITIONER's
    // Supabase auth session. A portal client has none, so 0173 returns an empty
    // list rather than an error — a silent, total failure of this surface.
    const forbidden = /getActiveServices/;
    expect(CODE).not.toMatch(forbidden);
    expect(codeOnly(portalPage)).not.toMatch(forbidden);
    // NEGATIVE CONTROL.
    expect(`const s = await getActiveServices(studio.id);`).toMatch(forbidden);
  });

  it("the ONE loader is scoped by studio_id AND active, as query filters", () => {
    const loader = queries.slice(queries.indexOf("export async function getPortalBookableServices"));
    expect(loader).toMatch(/\.eq\("studio_id",\s*studioId\)/);
    expect(loader).toMatch(/\.eq\("active",\s*true\)/);
  });

  it("the loader answers null on a read failure, never an empty menu", () => {
    const loader = queries.slice(
      queries.indexOf("export async function getPortalBookableServices"),
      queries.indexOf("export function pickPortalBookableService"),
    );
    expect(loader).toMatch(/if\s*\(error\)\s*\{[\s\S]*?return null;/);
  });

  it("the menu, the validation and the duration all come from that one read", () => {
    // The action resolves a service ONLY through the shared loader + picker, so
    // a service the menu would not show is one the validator cannot find.
    expect(CODE).toContain("getPortalBookableServices");
    expect(CODE).toContain("pickPortalBookableService");
    expect(codeOnly(portalPage)).toContain("getPortalBookableServices");
    // And the duration handed to slot generation and to the command is that
    // row's own column, not a second lookup.
    expect(CODE).toMatch(/service\.service\.default_duration_minutes/);
  });

  it("the action performs no services read of its own", () => {
    const forbidden = /from\(\s*["']services["']\s*\)/;
    expect(CODE).not.toMatch(forbidden);
    expect(`admin.from("services").select("*")`).toMatch(forbidden);
  });
});

// ---------------------------------------------------------------------------
// P2-1. Only slots the public contract would accept are ever offered.
// ---------------------------------------------------------------------------

describe("P2-1. the offered set is the public set", () => {
  it("applies the shared past-time filter to the offered slots", () => {
    expect(CODE).toContain("filterFutureSlots");
    // NEGATIVE CONTROL: the raw generator alone is not sufficient.
    expect(CODE).toContain("getAvailableSlots");
  });

  it("bounds the requested date by the public booking horizon", () => {
    expect(CODE).toContain("horizonRangeInStudioTz");
    expect(CODE).toMatch(/minDateStr/);
    expect(CODE).toMatch(/maxDateStr/);
  });

  it("re-checks the submitted instant against the horizon and the clock", () => {
    expect(CODE).toContain("isWithinPublicBookingHorizon");
    expect(CODE).toMatch(/start\.getTime\(\)\s*<=\s*Date\.now\(\)/);
  });

  it("uses the STUDIO-LOCAL date for the re-check, never the UTC date", () => {
    // Using the UTC date would look up the wrong calendar day for a
    // late-evening booking west of UTC — the same trap the public route
    // documents.
    expect(CODE).toMatch(/localDateString\(start,\s*studio\.timezone\)/);
  });

  it("builds the capacity-OFF studio shape the public loader is given", () => {
    // Passing `practitioner_capacity_enabled` or a practitioner here would put
    // the portal on a different slot grid from the one the command re-derives.
    const shape = CODE.slice(CODE.indexOf("function publicStudioShape"));
    expect(shape).not.toContain("practitioner_capacity_enabled");
    expect(CODE).not.toMatch(/getAvailableSlots\([\s\S]{0,400}?practitionerId/);
  });
});

// ---------------------------------------------------------------------------
// P2-2. A committed booking runs the established post-commit workflow.
// ---------------------------------------------------------------------------

describe("P2-2. the post-commit workflow is the established one", () => {
  const EFFECTS = [
    ["client confirmation email", /sendBookingConfirmationToClient/],
    ["truthful email bookkeeping", /recordEmailAttempt/],
    ["email failure alerting", /logEmailFailure/],
    ["practitioner notification record", /recordPractitionerNotification/],
    ["practitioner email", /sendBookingNotificationToPractitioner/],
    ["existing booking SMS path", /sendBookingConfirmationSmsToClient/],
    ["intake link", /ensureIntakeForClient/],
    ["calendar revalidation", /revalidatePath\("\/calendar"\)/],
    ["portal revalidation", /revalidatePath\("\/portal"\)/],
  ] as const;

  for (const [label, shape] of EFFECTS) {
    it(`runs the ${label}`, () => {
      expect(CODE, label).toMatch(shape);
    });
  }

  it("every post-commit effect is contained so it cannot fail the booking", () => {
    // Each one goes through the fail-soft helper. A bare call would let a
    // provider exception surface a COMMITTED booking as an error.
    //
    // The search is restricted to the POST-COMMIT REGION. Searching the whole
    // module would match the `import` line for each helper — which sits at the
    // top of the file with no wrapper anywhere near it — and the rule would
    // fail for a reason that has nothing to do with containment.
    const region = CODE.slice(CODE.indexOf("const postCommit"));
    expect(region.length, "the post-commit region must exist").toBeGreaterThan(0);
    for (const [label, shape] of EFFECTS) {
      if (label === "portal revalidation") continue; // same postCommit call as /calendar
      const global = new RegExp(shape.source, "g");
      const hits = [...region.matchAll(global)].map((m) => m.index ?? -1);
      expect(hits.length, `${label} must appear in the post-commit region`).toBeGreaterThan(0);
      // `postCommit<{...}>(` is a legitimate call shape — the helper is
      // generic, so an `.includes("postCommit(")` check would miss every call
      // that names its type argument and report a contained effect as bare.
      const contained = hits.some((idx) =>
        /postCommit\s*[<(]/.test(region.slice(Math.max(0, idx - 600), idx)),
      );
      expect(contained, `${label} must be inside a postCommit(...) wrapper`).toBe(true);
    }
  });

  it("NEGATIVE CONTROL: containment fails for an effect called bare", () => {
    const bare = "const postCommit = 1;\nawait sendBookingConfirmationToClient({});";
    const region = bare.slice(bare.indexOf("const postCommit"));
    const idx = region.search(/sendBookingConfirmationToClient/);
    expect(region.slice(Math.max(0, idx - 400), idx)).not.toContain("postCommit(");
  });

  it("the raw management token is never logged", () => {
    // Only its SHA-256 is persisted; the raw token lives in the response URL.
    const logCalls = [...CODE.matchAll(/logRebookError\([\s\S]*?\);/g)].map((m) => m[0]);
    expect(logCalls.length).toBeGreaterThan(0);
    for (const call of logCalls) {
      expect(call).not.toMatch(/appointmentToken|manageUrl|cancellationUrl|rescheduleUrl/);
      // Nor any raw client identifier.
      expect(call).not.toMatch(/clientEmail|clientName|clientPhone/);
    }
  });

  it("does not widen SMS eligibility, add consent, or change sender routing", () => {
    // The gates live inside the sender. This caller passes the STORED values
    // through and writes none of them.
    const forbidden = /sms_consent_at:\s*(?!clientSmsConsentAt)/;
    expect(CODE).not.toMatch(/sms_consent_source/);
    expect(CODE).not.toMatch(/update\([\s\S]{0,120}sms_consent_at/);
    expect(CODE).toMatch(/sms_consent_at:\s*clientSmsConsentAt/);
    expect(CODE).toMatch(/sms_opted_out_at:\s*clientSmsOptedOutAt/);
    expect(`sms_consent_at: nowIso`).toMatch(forbidden);
  });

  it("a committed booking is never reported as a failure", () => {
    // The success return is unconditional once `createdId` exists: no post-commit
    // branch may return a refusal after it.
    const commitIdx = CODE.indexOf("const postCommit");
    const tail = CODE.slice(commitIdx);
    expect(tail).not.toMatch(/return\s+refuse\(/);
  });
});

// ---------------------------------------------------------------------------
// The submit latch and the slot loader must not be able to strand the client.
// ---------------------------------------------------------------------------

describe("the one-press latch survives a REJECTED action", () => {
  /** The whole `startBooking(async () => { ... })` body. */
  const bookingBody = (() => {
    const start = FORM_CODE.indexOf("startBooking(async () =>");
    expect(start, "the booking transition must exist").toBeGreaterThan(-1);
    return FORM_CODE.slice(start, FORM_CODE.indexOf("if (services.length === 0)", start));
  })();

  it("awaits the action inside a try", () => {
    const call = bookingBody.indexOf("await bookAnotherAppointmentAction(fd)");
    expect(call).toBeGreaterThan(-1);
    expect(bookingBody.slice(0, call)).toMatch(/try\s*\{/);
  });

  it("releases the latch in the catch, not only on a structured refusal", () => {
    // A transient network failure or an unexpected pre-commit exception REJECTS
    // the action. React clears the pending flag, so the button looks usable
    // again — but a latch left set makes every later press return immediately,
    // and the client cannot book again until they reload the page.
    const catchIdx = bookingBody.search(/\}\s*catch\s*(\([^)]*\))?\s*\{/);
    expect(catchIdx, "the action call must be wrapped").toBeGreaterThan(-1);
    const catchBody = bookingBody.slice(catchIdx, catchIdx + 500);
    expect(catchBody).toMatch(/submittedRef\.current\s*=\s*false/);
  });

  it("the catch reports RETRYABLE copy — nothing was committed on that path", () => {
    // Bounded to the catch's OWN block. A fixed character window runs past it
    // into the refusal handling and the success path, so `setDone` would be
    // found there and the rule would fail against correct code.
    const catchIdx = bookingBody.search(/\}\s*catch\s*(\([^)]*\))?\s*\{/);
    const end = bookingBody.indexOf("if (!res.ok)", catchIdx);
    expect(end, "the catch must be followed by the refusal handling").toBeGreaterThan(catchIdx);
    const catchBody = bookingBody.slice(catchIdx, end);
    expect(catchBody).toMatch(/setError\(/);
    // ...and it must not claim a booking happened.
    expect(catchBody).not.toMatch(/setDone\(/);
  });

  it("NEGATIVE CONTROL: the rule fires on the un-wrapped shape", () => {
    const naive = `startBooking(async () => {
      const res = await bookAnotherAppointmentAction(fd);
      if (!res.ok) { submittedRef.current = false; return; }
    });`;
    const call = naive.indexOf("await bookAnotherAppointmentAction(fd)");
    expect(naive.slice(0, call)).not.toMatch(/try\s*\{/);
    expect(naive.search(/\}\s*catch\s*(\([^)]*\))?\s*\{/)).toBe(-1);
  });
});

describe("there is exactly ONE slot loader, and it reads CURRENT state", () => {
  it("the action is called from one place only", () => {
    // A second call sited in the submit handler closes over the service and date
    // as they were when the submit STARTED. If the client changes either while
    // the booking is in flight, writing that answer back shows one service's
    // times under another's — and every press then submits a choice the server
    // refuses.
    const calls = [...FORM_CODE.matchAll(/loadPortalRebookSlotsAction\(/g)];
    expect(calls, "only the effect may load slots").toHaveLength(1);
  });

  it("a refusal asks for a refresh through the nonce instead", () => {
    expect(FORM_CODE).toMatch(/setSlotReloadNonce\(\s*\(n\)\s*=>\s*n\s*\+\s*1\s*\)/);
    expect(FORM_CODE).toMatch(/\}, \[serviceId, date, slotReloadNonce, router\]\);/);
  });

  it("the loader keeps its cancellation flag, so a late answer is retired", () => {
    const effect = FORM_CODE.slice(
      FORM_CODE.indexOf("useEffect(() => {"),
      FORM_CODE.indexOf("}, [serviceId, date, slotReloadNonce, router]);"),
    );
    expect(effect).toMatch(/let cancelled = false;/);
    expect(effect).toMatch(/if \(cancelled\) return;/);
    expect(effect).toMatch(/cancelled = true;/);
  });

  it("the loader does NOT clear the error it was asked to explain", () => {
    // Clearing it here would wipe "that time is no longer available" at the
    // moment the refusal asked for the refresh that proves it. The selection
    // controls clear it instead — the moment it stops being true.
    const effect = FORM_CODE.slice(
      FORM_CODE.indexOf("useEffect(() => {"),
      FORM_CODE.indexOf("}, [serviceId, date, slotReloadNonce, router]);"),
    );
    expect(effect).not.toMatch(/setError\(null\)/);
    expect(FORM_CODE).toMatch(/onChange=\{\(e\) => \{\s*setError\(null\);/);
  });

  it("NEGATIVE CONTROL: two call sites would fail the single-loader rule", () => {
    const twoCalls = "loadPortalRebookSlotsAction({a});\nloadPortalRebookSlotsAction({b});";
    expect([...twoCalls.matchAll(/loadPortalRebookSlotsAction\(/g)]).toHaveLength(2);
  });
});

describe("the selection cannot move underneath an in-flight booking", () => {
  const CONTROLS = [
    ["service select", 'data-testid="portal-rebook-service"'],
    ["date input", 'data-testid="portal-rebook-date"'],
    ["next-available button", 'data-testid="portal-rebook-next-available"'],
    ["slot buttons", 'data-testid="portal-rebook-slot"'],
  ] as const;

  for (const [label, testid] of CONTROLS) {
    it(`${label} is inert while booking`, () => {
      const idx = FORM_CODE.indexOf(testid);
      expect(idx, label).toBeGreaterThan(-1);
      const element = FORM_CODE.slice(idx, idx + 420);
      expect(element, `${label} must carry disabled={... booking}`).toMatch(
        /disabled=\{[^}]*\bbooking\b[^}]*\}/,
      );
    });
  }

  it("NEGATIVE CONTROL: the rule fires on a control with no disabled prop", () => {
    const bare = 'data-testid="portal-rebook-service"\n value={serviceId}\n onChange={x}';
    expect(bare).not.toMatch(/disabled=\{[^}]*\bbooking\b[^}]*\}/);
  });
});
