import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #289. The calendar feed URL is a BEARER secret stored by third-party
// calendar providers (Google / Apple / Outlook) along with the event
// contents. The default ICS must therefore expose NO client PII and NO
// treatment context, only the practitioner's busy/free times. This proves
// the rendered feed leaks none of the planted sensitive fields and keeps the
// generic, importable shape.

// ---------------------------------------------------------------------------
// Behavioral: render the actual route output and assert no PII leaks.
// ---------------------------------------------------------------------------
const APP_ORIGIN = "https://hone.care";

// A chainable + thenable Supabase query mock. Chain methods return the same
// builder; `.maybeSingle()` resolves the table result; awaiting the builder
// directly (the appointments query ends with `.order(...)`) resolves it too.
function tableBuilder(result: { data: unknown; error: unknown }) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "gte", "order"]) {
    b[m] = () => b;
  }
  b.maybeSingle = () => Promise.resolve(result);
  b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(onF, onR);
  return b;
}

// Planted "as if the DB returned them" sensitive values. After the fix the
// route does not SELECT or render these, so none may appear in the feed.
const PLANTED = {
  clientFirst: "Janet",
  clientLast: "Quibblesworth",
  clientName: "Janet Quibblesworth",
  email: "janet.quibblesworth@example.com",
  phone: "+1 (555) 867-5309",
  address: "44 Secret Lane, Hidden City",
  notes: "sensitive treatment note about the area",
  modality: "electrolysis",
  token: "rawfeedtoken_abcdef1234567890abcdef",
};

const APPT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeAdminMock() {
  const results: Record<string, { data: unknown; error: unknown }> = {
    practitioners: {
      data: { id: "p1", studio_id: "s1", active: true },
      error: null,
    },
    appointments: {
      data: [
        {
          id: APPT_ID,
          starts_at: "2026-07-01T15:00:00.000Z",
          ends_at: "2026-07-01T15:30:00.000Z",
          // Extra sensitive fields the route must ignore:
          status: "confirmed",
          client: { name: PLANTED.clientName, email: PLANTED.email, phone: PLANTED.phone },
          service: { modality: PLANTED.modality },
          notes: PLANTED.notes,
        },
      ],
      error: null,
    },
    studios: { data: { address: "123 Studio St" }, error: null },
  };
  return { from: (table: string) => tableBuilder(results[table]) };
}

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => makeAdminMock()),
}));
vi.mock("@/lib/app-origin", () => ({
  getRequiredAppOrigin: vi.fn(() => APP_ORIGIN),
}));

import { GET } from "@/app/calendar-feed/[token]/route";

afterEach(() => vi.clearAllMocks());

async function renderFeed(): Promise<{ body: string; res: Response }> {
  const token = "a_valid_feed_token_1234567890";
  const res = await GET(
    new Request(`http://localhost/calendar-feed/${token}.ics`),
    { params: Promise.resolve({ token: `${token}.ics` }) },
  );
  const body = await res.text();
  return { body, res };
}

describe("calendar feed default ICS: no PII leaks", () => {
  it("renders a valid importable ICS with the generic summary + description", async () => {
    const { body, res } = await renderFeed();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/calendar/);
    expect(body).toMatch(/^BEGIN:VCALENDAR/);
    expect(body).toContain("END:VCALENDAR");
    expect(body).toContain("SUMMARY:Hone appointment");
    expect(body).toContain("Appointment scheduled in Hone. Open Hone for details.");
  });

  it("keeps a stable, PII-free UID and accurate start/end times", async () => {
    const { body } = await renderFeed();
    expect(body).toContain(`UID:${APPT_ID}@hone.care`);
    expect(body).toContain("DTSTART:20260701T150000Z");
    expect(body).toContain("DTEND:20260701T153000Z");
  });

  it("contains NONE of the planted client PII or treatment context", async () => {
    const { body } = await renderFeed();
    for (const leak of [
      PLANTED.clientFirst,
      PLANTED.clientLast,
      PLANTED.clientName,
      PLANTED.email,
      PLANTED.phone,
      PLANTED.address,
      PLANTED.notes,
      "Client:",
      "Electrolysis",
      "electrolysis",
      "Laser",
      "Type:",
      "Status:",
    ]) {
      expect(body, `feed must not contain "${leak}"`).not.toContain(leak);
    }
  });

  it("contains no token / signed URL / storage path / Stripe id", async () => {
    const { body } = await renderFeed();
    expect(body).not.toContain(PLANTED.token);
    expect(body).not.toMatch(/[?&]token=/);
    expect(body).not.toMatch(/object\/sign|treatment-images/);
    expect(body).not.toMatch(/pi_[A-Za-z0-9]+_secret_|sk_(live|test)_|whsec_/);
    // The only URL is the auth-gated /calendar/<id> deep link (no token).
    expect(body).toContain(`${APP_ORIGIN}/calendar/${APPT_ID}`);
  });

  it("does not advertise CDN/public caching of the bearer URL", async () => {
    const { res } = await renderFeed();
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("returns a generic 404 (no ICS) for a too-short token", async () => {
    const res = await GET(
      new Request("http://localhost/calendar-feed/short.ics"),
      { params: Promise.resolve({ token: "short.ics" }) },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Source-grep: the route must not re-introduce client/treatment fields.
// ---------------------------------------------------------------------------
describe("calendar feed route source: no client/treatment fields (PR #289)", () => {
  const ROUTE = readFileSync(
    path.resolve(__dirname, "../../../app/calendar-feed/[token]/route.ts"),
    "utf8",
  );
  const code = ROUTE.split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  it("the appointment SELECT does not pull client name or service modality", () => {
    expect(code).not.toMatch(/client:\s*clients\(/);
    expect(code).not.toMatch(/service:\s*services\(/);
    expect(code).not.toMatch(/clients\(name\)/);
    expect(code).not.toMatch(/services\(modality\)/);
  });

  it("the event description is the generic constant, not a client/modality composition", () => {
    expect(code).toMatch(/Appointment scheduled in Hone\. Open Hone for details\./);
    expect(code).not.toMatch(/Client:\s*\$\{/);
    expect(code).not.toMatch(/modalityLabel\(/);
    expect(code).not.toMatch(/client\?\.name/);
  });

  it("SUMMARY stays generic", () => {
    expect(code).toMatch(/summary:\s*"Hone appointment"/);
  });
});
