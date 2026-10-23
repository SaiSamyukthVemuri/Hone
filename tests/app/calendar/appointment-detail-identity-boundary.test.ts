import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import {
  getAccessFallbackHTTPStatus,
  isHTTPAccessFallbackError,
} from "next/dist/client/components/http-access-fallback/http-access-fallback";

// SENTRY-IDENTITY-01. The production Sentry group
//
//   "No active practitioner found for the signed-in user."   /calendar/[id]
//
// is this page throwing on an EXPECTED identity state. Next renders a page in
// parallel with its layouts, so the shell layout's redirect does not stop the
// page from running, and the page's throw is still handed to
// `onRequestError = Sentry.captureRequestError`. On a soft navigation the shell
// layout is not re-rendered at all, so the throw is what the practitioner sees.
//
// This drives the REAL page module and the REAL identity resolver in
// lib/supabase/queries.ts against a fake Supabase client, and classifies what
// the page does with Next's own redirect / not-found helpers (the real
// `redirect()` and `notFound()` run; nothing in next/navigation is mocked).
// Each identity state must end in the controlled navigation it means, and a
// genuine read failure must stay a loud error.

const APPOINTMENT_ID = "6b2f9c64-27a1-4f0e-8f0a-1f4f6f1c2d3e";

type Recorded = { table: string; select?: string; filters: Array<[string, unknown]> };

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  rows: [] as Array<Record<string, unknown>>,
  membershipError: null as { message: string } | null,
  selectedStudioId: null as string | null,
  reads: [] as Array<{ table: string; select?: string; filters: Array<[string, unknown]> }>,
}));

vi.mock("@/lib/supabase/selected-studio", () => ({
  readSelectedStudioId: async () => state.selectedStudioId,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: state.user }, error: null }),
    },
    from(table: string) {
      const read: Recorded = { table, filters: [] };
      state.reads.push(read);
      const settle = () => {
        if (table === "practitioners") {
          return state.membershipError
            ? { data: null, error: state.membershipError }
            : { data: state.rows, error: null };
        }
        // The appointment is never in the resolved studio in these cases: the
        // page must reach this read only once identity resolved, and then
        // answer with notFound().
        if (table === "appointments") return { data: null, error: null };
        throw new Error(`unexpected read of ${table}`);
      };
      const builder = {
        select(columns: string) {
          read.select = columns;
          return builder;
        },
        eq(column: string, value: unknown) {
          read.filters.push([column, value]);
          return builder;
        },
        maybeSingle: async () => settle(),
        then<T>(resolve: (v: ReturnType<typeof settle>) => T, reject?: (e: unknown) => T) {
          return Promise.resolve()
            .then(settle)
            .then(resolve, reject);
        },
      };
      return builder;
    },
  }),
}));

import AppointmentDetailPage from "@/app/(app)/calendar/[id]/page";

type Outcome =
  | { kind: "redirect"; url: string }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "rendered" };

async function renderDetail(): Promise<Outcome> {
  try {
    await AppointmentDetailPage({
      params: Promise.resolve({ id: APPOINTMENT_ID }),
      searchParams: Promise.resolve({}),
    });
    return { kind: "rendered" };
  } catch (err) {
    if (isRedirectError(err)) return { kind: "redirect", url: getURLFromRedirectError(err) };
    if (isHTTPAccessFallbackError(err) && getAccessFallbackHTTPStatus(err) === 404) {
      return { kind: "notFound" };
    }
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function membership(studioId: string, role: "owner" | "practitioner" = "practitioner") {
  return {
    id: `prac-${studioId}`,
    user_id: "user-1",
    studio_id: studioId,
    role,
    active: true,
    studio: { id: studioId, name: `Studio ${studioId}`, timezone: "UTC" },
  };
}

const appointmentReads = () => state.reads.filter((r) => r.table === "appointments");

beforeEach(() => {
  state.user = { id: "user-1" };
  state.rows = [];
  state.membershipError = null;
  state.selectedStudioId = null;
  state.reads = [];
});

describe("expected identity states end in a controlled navigation, never a thrown error", () => {
  it("signed in with NO active membership -> /no-access (the production Sentry group)", async () => {
    state.rows = [];
    const outcome = await renderDetail();
    expect(outcome).toEqual({ kind: "redirect", url: "/no-access" });
    expect(appointmentReads()).toHaveLength(0);
  });

  it("2+ memberships and NO selection -> the chooser, never an auto-picked studio", async () => {
    state.rows = [membership("s1", "owner"), membership("s2")];
    const outcome = await renderDetail();
    expect(outcome).toEqual({ kind: "redirect", url: "/no-access?reason=multiple-studios" });
    expect(appointmentReads()).toHaveLength(0);
  });

  it("2+ memberships and a STALE selection -> the chooser; the cookie grants nothing", async () => {
    state.rows = [membership("s1", "owner"), membership("s2")];
    state.selectedStudioId = "studio-the-user-is-not-in";
    const outcome = await renderDetail();
    expect(outcome).toEqual({ kind: "redirect", url: "/no-access?reason=multiple-studios" });
    expect(appointmentReads()).toHaveLength(0);
  });

  it("no auth user -> /login", async () => {
    state.user = null;
    const outcome = await renderDetail();
    expect(outcome).toEqual({ kind: "redirect", url: "/login" });
    expect(state.reads).toHaveLength(0);
  });
});

describe("genuine failures stay loud", () => {
  it("a FAILED membership read is an error, not a redirect and not 'no access'", async () => {
    state.membershipError = { message: "connection terminated" };
    const outcome = await renderDetail();
    expect(outcome).toEqual({
      kind: "error",
      message: "Failed to load practitioner: connection terminated",
    });
    expect(appointmentReads()).toHaveLength(0);
  });
});

describe("a resolved identity scopes the appointment to the RESOLVED studio", () => {
  it("one membership: reads the appointment in that studio; outside it is notFound", async () => {
    state.rows = [membership("s1", "owner")];
    const outcome = await renderDetail();
    expect(outcome).toEqual({ kind: "notFound" });
    expect(appointmentReads()).toEqual([
      expect.objectContaining({
        filters: [
          ["id", APPOINTMENT_ID],
          ["studio_id", "s1"],
        ],
      }),
    ]);
  });

  it("2+ memberships with a VALID selection: scoped to the selected studio, not the first row", async () => {
    state.rows = [membership("s1", "owner"), membership("s2")];
    state.selectedStudioId = "s2";
    const outcome = await renderDetail();
    expect(outcome).toEqual({ kind: "notFound" });
    expect(appointmentReads()).toEqual([
      expect.objectContaining({
        filters: [
          ["id", APPOINTMENT_ID],
          ["studio_id", "s2"],
        ],
      }),
    ]);
  });
});
