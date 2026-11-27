import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// MSG-LOG-RAW-ERROR call site: the team invitation email goes through the
// Resend transport directly, so its failure log is this file's job. A provider
// error object and a thrown error can both carry the destination and provider
// text; neither may reach a log line. Synthetic values only.

const LEAK_PHONE = "+1 555 010 0199";
const LEAK_EMAIL = "leak.probe@example.test";
const INVITEE = "invitee.synthetic@example.test";

const send = vi.hoisted(() => vi.fn());
// The invitation goes through the SHARED transport (getResendTransport), so the E2E capture ledger sees it.
const transportRef = vi.hoisted(() => ({ current: null as null | { emails: { send: unknown } } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/email/client", () => ({
  getResendTransport: () => transportRef.current,
  FROM_ADDRESS: "Hone <hello@hone.care>",
}));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: { id: "practitioner-1", role: "owner", display_name: "Owner", email: "owner@example.test" },
    studio: { id: "studio-1", name: "Synthetic Studio" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "ilike", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = async () => ({ data: null, error: null });
    // the existing-member / pending-invite checks now fetch a bounded candidate list and await it
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null });
    chain.insert = async () => ({ error: null });
    return { from: () => chain };
  }),
}));

import { invitePractitionerAction } from "@/app/(app)/settings/team/actions";

function inviteForm(): FormData {
  const fd = new FormData();
  fd.set("email", INVITEE);
  fd.set("role", "practitioner");
  return fd;
}

let logged: string[];

beforeEach(() => {
  send.mockReset();
  transportRef.current = { emails: { send } };
  logged = [];
  for (const level of ["error", "warn", "info", "log", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: null }))).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function expectNoLeak() {
  const text = logged.join("\n");
  expect(text).not.toContain(LEAK_PHONE);
  // No fragment of the probe phone (+1 555 010 0199). A bare "555" also matched an
  // ISO timestamp's milliseconds (e.g. "…:36.555Z") and failed at random.
  expect(text).not.toMatch(/555\D{0,3}010|010\D?0199|5550100199/);
  expect(text).not.toContain(LEAK_EMAIL);
  expect(text).not.toContain(INVITEE);
}

describe("team invitation email failure log (MSG-LOG-RAW-ERROR)", () => {
  it("a thrown transport error never reaches the log line; the invite still succeeds", async () => {
    send.mockRejectedValue(new Error(`connect failed for ${LEAK_EMAIL} (sms ${LEAK_PHONE})`));

    const result = await invitePractitionerAction(inviteForm());

    expect(result).toEqual({ ok: true, email: INVITEE });
    expect(send).toHaveBeenCalledTimes(1);
    expectNoLeak();
    expect(logged).toEqual(["team_invitation_email_failed:transport_threw:Error:retryable=true"]);
  });

  it("a provider error object never reaches the log line", async () => {
    send.mockResolvedValue({
      data: null,
      error: {
        name: "validation_error",
        statusCode: 422,
        message: `Invalid \`to\` field: ${LEAK_EMAIL}, reply ${LEAK_PHONE}`,
      },
    });

    const result = await invitePractitionerAction(inviteForm());

    expect(result).toEqual({ ok: true, email: INVITEE });
    expectNoLeak();
    expect(logged).toEqual(["team_invitation_email_failed:provider_error:validation_error:retryable=false"]);
  });

  it("a provider error whose name is free text logs only a closed placeholder", async () => {
    send.mockResolvedValue({
      data: null,
      error: { name: `bounce ${LEAK_EMAIL}`, statusCode: 503, message: LEAK_PHONE },
    });

    await invitePractitionerAction(inviteForm());

    expectNoLeak();
    expect(logged).toEqual(["team_invitation_email_failed:provider_error:unknown:retryable=true"]);
  });

  it("a thrown non-Error value logs only a closed placeholder", async () => {
    send.mockRejectedValue(`${LEAK_EMAIL} ${LEAK_PHONE}`);

    await invitePractitionerAction(inviteForm());

    expectNoLeak();
    expect(logged).toEqual(["team_invitation_email_failed:transport_threw:unknown:retryable=true"]);
  });

  it("control: a successful send logs nothing", async () => {
    send.mockResolvedValue({ data: { id: "email-1" }, error: null });

    const result = await invitePractitionerAction(inviteForm());

    expect(result).toEqual({ ok: true, email: INVITEE });
    expect(logged).toEqual([]);
  });

  it("the invitation is handed to the shared transport once, to the invitee, with the studio's sender", async () => {
    send.mockResolvedValue({ data: { id: "email-1" }, error: null });

    await invitePractitionerAction(inviteForm());

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ from: "Hone <hello@hone.care>", to: INVITEE });
    expect(typeof send.mock.calls[0][0].subject).toBe("string");
  });

  it("no transport configured: nothing is sent, the invite still succeeds, one closed warning", async () => {
    transportRef.current = null;

    const result = await invitePractitionerAction(inviteForm());

    expect(result).toEqual({ ok: true, email: INVITEE });
    expect(send).not.toHaveBeenCalled();
    expectNoLeak();
    expect(logged).toEqual(["Skipping invitation email: Resend client is not configured."]);
  });
});
