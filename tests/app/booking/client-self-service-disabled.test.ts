import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactElement, ReactNode } from "react";

// ===========================================================================
// HON-47 — the THREE CLIENT SURFACES when a studio switches self-service off.
// ===========================================================================
//
// 0234 is the authority: it refuses inside the two client-only commands, and
// `tests/db/client-self-service-controls.db.test.ts` proves that against a real
// database. This file proves the OTHER half — that no surface offers an action
// the database will refuse, which is the part a client actually experiences.
//
// WHAT EACH SURFACE MUST DO:
//
//   /cancel      flag off -> the page shows the approved refusal and NO form;
//                the action maps the command's refusal word to the approved
//                sentence instead of the generic "can't be used right now"
//   /reschedule  flag off -> the page shows the approved refusal, and EVERY
//                entry point refuses, INCLUDING the two that fetch slots
//   /manage      offers each CTA only when its destination will accept it, and
//                its intro sentence matches what it offers
//
// Every copy assertion renders the REAL component through react-dom/server, so
// a refactor that reintroduces a link under different phrasing still fails.
//
// THE VACUITY THIS FILE HAS TO ANSWER, stated because the mock cannot:
// `makeQuery` ignores the select string, so a studio row carrying both flags
// would be returned even if an action FORGOT to project them — and in
// production a missing column plus the helpers' `?? true` means the surface
// silently stays open. A behavioural test alone therefore cannot see that
// mistake. The source-contract describe at the bottom closes it by reading the
// real select strings off disk.

const TOKEN = "raw-url-token";
const STUDIO_ID = "22222222-2222-4222-8222-222222222222";
const APPT_ID = "11111111-1111-4111-8111-111111111111";

const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
const writes: Array<{ table: string; op: string }> = [];

const scenario = {
  cancellationEnabled: true,
  rescheduleEnabled: true,
  status: "confirmed" as string,
  startsAt: new Date(Date.now() + 86_400_000).toISOString(),
  cancelResult: "cancelled" as string,
};

// A TREATMENT at a studio with no waitlist slug, so EMERG-01 never fires here
// and every refusal this file sees is HON-47's own.
const SERVICE = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "Full Face",
  modality: "electrolysis",
  price_cents: 9_000,
  default_duration_minutes: 45,
};

function studioRow() {
  return {
    id: STUDIO_ID,
    name: "Test Studio",
    slug: "e2e-open-studio",
    timezone: "UTC",
    public_booking_horizon_months: 3,
    cancellation_policy_text: null,
    no_show_policy_text: null,
    client_cancellation_enabled: scenario.cancellationEnabled,
    client_reschedule_enabled: scenario.rescheduleEnabled,
  };
}

function makeQuery(table: string) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    lte: () => chain,
    order: () => chain,
    limit: () => chain,
    insert: () => (writes.push({ table, op: "insert" }), chain),
    update: () => (writes.push({ table, op: "update" }), chain),
    upsert: () => (writes.push({ table, op: "upsert" }), chain),
    delete: () => (writes.push({ table, op: "delete" }), chain),
    async maybeSingle() {
      if (table === "appointments") {
        return {
          data: {
            id: APPT_ID,
            studio_id: STUDIO_ID,
            client_id: "33333333-3333-4333-8333-333333333333",
            practitioner_id: null,
            status: scenario.status,
            starts_at: scenario.startsAt,
            duration_minutes: 45,
            service_id: SERVICE.id,
            cancellation_token_hash: "a".repeat(64),
            studio: studioRow(),
            service: SERVICE,
            client: { name: "Test Client" },
          },
          error: null,
        };
      }
      if (table === "studios") return { data: studioRow(), error: null };
      return { data: null, error: null };
    },
    async single() {
      return chain.maybeSingle();
    },
    then(res: (v: { data: never[]; error: null }) => unknown) {
      return Promise.resolve({ data: [], error: null }).then(res);
    },
  };
  return chain;
}

const admin = {
  from: (table: string) => makeQuery(table),
  async rpc(fn: string, args: Record<string, unknown>) {
    rpcCalls.push({ fn, args });
    return { data: [{ result: scenario.cancelResult }], error: null };
  },
};

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => admin,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitTokenRoute: async () => ({ allowed: true }),
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/booking/appointment-token", () => ({
  hashAppointmentToken: () => "a".repeat(64),
}));
vi.mock("@/lib/booking/tokens", () => ({
  verifyCancellationToken: () => ({ ok: false, error: "invalid" }),
  issueCancellationToken: () => "new-token",
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendCancellationEmail: async () => ({ ok: true }),
}));
vi.mock("@/lib/notifications/practitioner-notifications", () => ({
  recordPractitionerNotification: () => undefined,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; children?: ReactNode }) =>
      react.createElement("a", { href: props.href }, props.children),
  };
});

const { publicCancelAppointmentAction, fetchAppointmentForCancelAction } =
  await import("@/app/cancel/[token]/actions");
const CancelPage = (await import("@/app/cancel/[token]/page")).default;
const { CancellationNudge } = await import("@/app/cancel/[token]/CancelForm");
const {
  fetchAppointmentForRescheduleAction,
  fetchRescheduleSlotsAction,
  fetchNextAvailableDateForRescheduleAction,
} = await import("@/app/reschedule/[token]/actions");
const ReschedulePage = (await import("@/app/reschedule/[token]/page")).default;
const { fetchAppointmentForManageAction } =
  await import("@/app/manage/[token]/actions");
const ManagePage = (await import("@/app/manage/[token]/page")).default;
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const COPY = await import("@/lib/booking/client-self-service-copy");

// react-dom escapes ' and " in text nodes, so assertions written in the copy's
// own punctuation would never match the raw markup.
function decode(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#x2F;/g, "/")
    .replace(/—/g, "—");
}

const render = async (
  Page: (p: {
    params: Promise<{ token: string }>;
  }) => Promise<ReactElement>,
) =>
  decode(
    renderToStaticMarkup(
      await Page({ params: Promise.resolve({ token: TOKEN }) }),
    ),
  );

beforeEach(() => {
  rpcCalls.length = 0;
  writes.length = 0;
  Object.assign(scenario, {
    cancellationEnabled: true,
    rescheduleEnabled: true,
    status: "confirmed",
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    cancelResult: "cancelled",
  });
});

describe("HON-47 /cancel", () => {
  it("DISABLED: the fetch refuses with the code, and returns NO summary", async () => {
    scenario.cancellationEnabled = false;
    const r = await fetchAppointmentForCancelAction(TOKEN);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe(COPY.CLIENT_CANCELLATION_DISABLED_CODE);
    expect(r.error).toBe(COPY.CLIENT_CANCELLATION_DISABLED_ERROR);
    // The POINT of returning a refusal rather than a flag: there is no
    // summary, so no caller holds what it would need to render the form.
    expect(r).not.toHaveProperty("summary");
  });

  it("CONTROL — ENABLED: the identical fetch returns a summary", async () => {
    const r = await fetchAppointmentForCancelAction(TOKEN);
    expect(r.ok).toBe(true);
  });

  it("DISABLED: the page shows the approved refusal and NO cancel form", async () => {
    scenario.cancellationEnabled = false;
    const html = await render(CancelPage);
    expect(html).toContain(COPY.CLIENT_CANCELLATION_DISABLED_HEADLINE);
    expect(html).toContain(COPY.CLIENT_CANCELLATION_DISABLED_BODY);
    // The destructive control must be ABSENT, not merely disabled.
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("<form");
    // And it must not read as a broken link, which is what the generic
    // collapse message would have said.
    expect(html).not.toContain("can't be used right now");
  });

  it("CONTROL — ENABLED: the page renders the form", async () => {
    const html = await render(CancelPage);
    expect(html).toContain("<form");
    expect(html).not.toContain(COPY.CLIENT_CANCELLATION_DISABLED_HEADLINE);
  });

  it("the action maps the COMMAND's refusal word to the approved sentence", async () => {
    // Not reachable through the page any more, but reachable by anyone who
    // POSTs the action directly — and it is what 0234 actually returns.
    scenario.cancelResult = COPY.CLIENT_CANCELLATION_DISABLED_CODE;
    const fd = new FormData();
    fd.set("token", TOKEN);
    fd.set("reason", "other");
    fd.set("reason_label", "Other");
    const r = await publicCancelAppointmentAction(fd);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.code).toBe(COPY.CLIENT_CANCELLATION_DISABLED_CODE);
    expect(r.error).toBe(COPY.CLIENT_CANCELLATION_DISABLED_ERROR);
  });
});

describe("HON-47 the cancel page's reschedule pivot", () => {
  // A scheduling-shaped reason is what triggers the nudge at all.
  const REASON = "schedule_changed";
  const nudge = (clientRescheduleAllowed: boolean) =>
    decode(
      renderToStaticMarkup(
        createElement(CancellationNudge, {
          reason: REASON,
          freeConsultationWaitlistOnly: false,
          clientRescheduleAllowed,
          rescheduleHref: `/reschedule/${TOKEN}`,
        }),
      ),
    );

  it("RESCHEDULE DISABLED: explains, and offers NO link", () => {
    const html = nudge(false);
    expect(html).toContain(COPY.CLIENT_RESCHEDULE_DISABLED_HEADLINE);
    // No link, not even a disabled one: an <a> to a refusal is the dead end.
    expect(html).not.toContain("<a");
    expect(html).not.toContain("Reschedule instead");
  });

  it("CONTROL — ALLOWED: the PR #144 nudge is unchanged", () => {
    const html = nudge(true);
    expect(html).toContain("Reschedule instead");
    expect(html).toContain(`/reschedule/${TOKEN}`);
    expect(html).not.toContain(COPY.CLIENT_RESCHEDULE_DISABLED_HEADLINE);
  });
});

describe("HON-47 /reschedule", () => {
  it("DISABLED: every entry point refuses, including the two that fetch slots", async () => {
    scenario.rescheduleEnabled = false;
    const fetched = await fetchAppointmentForRescheduleAction(TOKEN);
    expect(fetched.ok).toBe(false);
    if (fetched.ok) throw new Error("unreachable");
    expect(fetched.code).toBe(COPY.CLIENT_RESCHEDULE_DISABLED_CODE);

    // THE REASON THIS GATE SITS IN THE SHARED HELPER. A studio that has
    // switched rescheduling off must not have its availability computed and
    // handed to a browser that is then refused.
    const DATE = new Date(Date.now() + 172_800_000)
      .toISOString()
      .slice(0, 10);

    const slots = await fetchRescheduleSlotsAction({
      token: TOKEN,
      date: DATE,
    });
    expect(slots.ok).toBe(false);
    // THE CODE, not merely `ok: false`. An earlier version of this test passed
    // the wrong parameter NAME, so these actions refused for an unrelated
    // reason and a bare falsity assertion was satisfied without HON-47 being
    // involved at all. `tsc` caught the name; this assertion is what makes the
    // test fail if the refusal ever comes from somewhere else.
    if (slots.ok) throw new Error("unreachable");
    expect(slots.code).toBe(COPY.CLIENT_RESCHEDULE_DISABLED_CODE);

    const next = await fetchNextAvailableDateForRescheduleAction({
      token: TOKEN,
      fromDate: DATE,
    });
    expect(next.ok).toBe(false);
    if (next.ok) throw new Error("unreachable");
    expect(next.code).toBe(COPY.CLIENT_RESCHEDULE_DISABLED_CODE);

    // And nothing was written on any of those three paths.
    expect(writes).toEqual([]);
  });

  it("CONTROL — ENABLED: the fetch returns a summary", async () => {
    const r = await fetchAppointmentForRescheduleAction(TOKEN);
    expect(r.ok).toBe(true);
  });

  it("DISABLED: the page shows the approved refusal, no slot picker, and no cancel CTA", async () => {
    scenario.rescheduleEnabled = false;
    const html = await render(ReschedulePage);
    expect(html).toContain(COPY.CLIENT_RESCHEDULE_DISABLED_HEADLINE);
    expect(html).toContain(COPY.CLIENT_RESCHEDULE_DISABLED_BODY);
    expect(html).not.toContain("can't be used right now");
    // DELIBERATE, and the reason this assertion exists: cancellation is a
    // SEPARATE switch that this refusal does not carry, so a cancel button
    // here could land on a second refusal.
    expect(html).not.toContain(`/cancel/${TOKEN}`);
  });

  it("CONTROL — ENABLED: the page renders the picker, not the refusal", async () => {
    const html = await render(ReschedulePage);
    // POSITIVE, deliberately. Asserting only the absence of the refusal
    // headline would also pass on the generic "can't be used right now"
    // collapse page, so it would not prove the enabled path works at all.
    expect(html).toContain("Choose a new time that works better for you.");
    expect(html).not.toContain(COPY.CLIENT_RESCHEDULE_DISABLED_HEADLINE);
  });
});

describe("HON-47 /manage offers only what will be accepted", () => {
  const set = (cancellation: boolean, reschedule: boolean) => {
    scenario.cancellationEnabled = cancellation;
    scenario.rescheduleEnabled = reschedule;
  };

  it("derives both flags onto the summary", async () => {
    set(false, true);
    const r = await fetchAppointmentForManageAction(TOKEN);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.summary.clientCancellationAllowed).toBe(false);
    expect(r.summary.clientRescheduleAllowed).toBe(true);
  });

  // The CTA row's own class string. Asserted directly because the row is a
  // flex container with a gap: suppressing both BUTTONS while still rendering
  // the row leaves a visible empty gap, and every href assertion in this
  // describe would pass anyway. Found by mutation — making the row
  // unconditional left all 21 tests green.
  const CTA_ROW = "flex flex-col gap-3 sm:flex-row sm:items-center";

  it("BOTH ON: both CTAs, and the intro promises both", async () => {
    set(true, true);
    const html = await render(ManagePage);
    expect(html).toContain(`/reschedule/${TOKEN}`);
    expect(html).toContain(`/cancel/${TOKEN}`);
    expect(html).toContain("You can reschedule or cancel from here.");
    expect(html).toContain(CTA_ROW);
  });

  it("CANCEL ONLY: no reschedule CTA, and the intro says so", async () => {
    set(true, false);
    const html = await render(ManagePage);
    expect(html).not.toContain(`/reschedule/${TOKEN}`);
    expect(html).toContain(`/cancel/${TOKEN}`);
    expect(html).toContain("You can cancel from here.");
    expect(html).toContain(COPY.CLIENT_RESCHEDULE_DISABLED_HEADLINE);
  });

  it("RESCHEDULE ONLY: no cancel CTA, and the intro says so", async () => {
    set(false, true);
    const html = await render(ManagePage);
    expect(html).toContain(`/reschedule/${TOKEN}`);
    expect(html).not.toContain(`/cancel/${TOKEN}`);
    expect(html).toContain("You can reschedule from here.");
    expect(html).toContain(COPY.CLIENT_CANCELLATION_DISABLED_HEADLINE);
  });

  it("NEITHER: no action CTA at all, and the page points at the studio", async () => {
    set(false, false);
    const html = await render(ManagePage);
    expect(html).not.toContain(`/reschedule/${TOKEN}`);
    expect(html).not.toContain(`/cancel/${TOKEN}`);
    expect(html).toContain("please contact the studio");
    // Not an EMPTY row: with nothing to offer, the container is not rendered
    // at all, so the page has no orphaned gap where the buttons were.
    expect(html).not.toContain(CTA_ROW);
    // The page must still offer a way onward rather than dead-ending.
    expect(html).toContain("/portal");
  });
});

// ===========================================================================
// THE SOURCE CONTRACT — what the mock above structurally cannot prove.
// ===========================================================================
//
// `makeQuery` ignores the select string. So every behavioural test above would
// pass unchanged if an action stopped projecting the flag columns — and in
// PRODUCTION that is not a neutral failure: PostgREST omits the field, the
// helpers' `?? true` reads it as permitted, and the surface silently reopens
// for a studio that switched it off. That is the exact shape of the bug this
// feature exists to prevent, so it is asserted against the real files.
describe("HON-47 every surface PROJECTS the flags it reads", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  const cases: Array<{ file: string; columns: string[] }> = [
    {
      file: "app/cancel/[token]/actions.ts",
      columns: ["client_cancellation_enabled", "client_reschedule_enabled"],
    },
    {
      // Only the reschedule flag: this surface never decides cancellation.
      file: "app/reschedule/[token]/actions.ts",
      columns: ["client_reschedule_enabled"],
    },
    {
      file: "app/manage/[token]/actions.ts",
      columns: ["client_cancellation_enabled", "client_reschedule_enabled"],
    },
  ];

  for (const { file, columns } of cases) {
    it(`${file} names its flag column(s) inside a studios embed`, () => {
      const src = read(file);
      // The column must appear INSIDE a `studio:studios(...)` projection, not
      // merely somewhere in the file — a mention in a comment or a type must
      // not satisfy this.
      const embeds = [...src.matchAll(/studio:studios\(([^)]*)\)/g)].map(
        (m) => m[1],
      );
      expect(embeds.length).toBeGreaterThan(0);
      for (const column of columns) {
        expect(
          embeds.some((e) => e.includes(column)),
          `${file} must project ${column} in a studios embed`,
        ).toBe(true);
      }
    });
  }

  it("the copy module is NOT server-only, or the client form cannot import it", () => {
    // `app/cancel/[token]/CancelForm.tsx` is a client component. If this line
    // ever appears, the build fails at the import — and the temptation is then
    // to re-type the sentences as literals, which is the duplication this
    // module exists to remove.
    const src = read("lib/booking/client-self-service-copy.ts");
    expect(src).not.toContain('import "server-only"');
  });

  it("the client form imports the shared copy rather than re-typing it", () => {
    const src = read("app/cancel/[token]/CancelForm.tsx");
    expect(src).toContain("client-self-service-copy");
    expect(src).toContain("CLIENT_RESCHEDULE_DISABLED_HEADLINE");
  });
});
