import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// SENTRY-BOOKING-ERR-01 (B). What the public booking PAGE does with each read
// outcome. The real page function runs against a loopback server that plays
// PostgREST through the real createAdminClient and supabase-js, and each read
// can be made to fail on its own.
//
// THE RULE: a read that did not complete answers nothing. Only a read that
// COMPLETED may produce a negative answer:
//
//   studio row absent            -> notFound() (404)
//   studio read failed           -> throw, to app/book/[slug]/error.tsx (500)
//   no active service / open day -> the setup notice, a true statement
//   services / availability read FAILED -> throw, NOT the setup notice
//
// The last row is the defect this file pins. Those two reads used to discard
// `error`, so a failed read became an empty list and an OPEN, fully configured
// studio was shown to visitors as "Online booking is not available for this
// studio yet." The two FAILED-read cases below resolve to exactly that copy on
// the unrepaired page, which is what makes them able to fail.
//
// The transport flavour of a failed read ("TypeError: fetch failed") is
// reproduced in tests/lib/booking/studio-by-slug-read-contract.test.ts. Here a
// 500 stands in for it: the page branches on `error`, not on its kind, and a
// 500 is not retried by supabase-js, so these cases stay fast.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

class NotFoundSignal extends Error {}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notFound: () => {
    throw new NotFoundSignal("notFound");
  },
}));

vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: (props: { href: string; className?: string; children?: ReactNode }) =>
      react.createElement("a", { href: props.href, className: props.className }, props.children),
  };
});

// The form is a client component whose module graph is the whole set of public
// booking Server Actions. What matters here is only WHETHER the page chose it.
vi.mock("@/app/book/[slug]/PublicBookForm", async () => {
  const react = await import("react");
  return {
    PublicBookForm: () =>
      react.createElement("div", { "data-testid": "public-book-form" }),
  };
});

type Answer = { rows: unknown[] } | { fail: true };
type Table = "studio" | "admission" | "services" | "availability";

const OK = (rows: unknown[]): Answer => ({ rows });
const FAIL: Answer = { fail: true };

const STUDIO = {
  id: "studio-1",
  slug: "willow",
  name: "Willow Studio",
  timezone: "America/Toronto",
  public_booking_horizon_months: 3,
  booking_description: null,
  address: null,
};
const OPEN_ADMISSION = {
  new_client_admission_mode: "open",
  new_client_admission_mode_set_at: "2026-09-01T00:00:00Z",
};
const SERVICE = {
  id: "svc-1",
  studio_id: "studio-1",
  name: "Consultation",
  active: true,
  sort_order: 0,
};
const OPEN_DAY = {
  day_of_week: 1,
  is_open: true,
  open_time: "09:00",
  close_time: "17:00",
};

let answers: Record<Table, Answer>;
let reads: Table[] = [];
let unexpected: string[] = [];
let server: http.Server;

function healthy(): Record<Table, Answer> {
  return {
    studio: OK([STUDIO]),
    admission: OK([OPEN_ADMISSION]),
    services: OK([SERVICE]),
    availability: OK([OPEN_DAY]),
  };
}

function tableFor(url: URL): Table | null {
  if (url.pathname === "/rest/v1/studios") {
    if (url.searchParams.has("slug")) return "studio";
    if (url.searchParams.has("id")) return "admission";
  }
  if (url.pathname === "/rest/v1/services") return "services";
  if (url.pathname === "/rest/v1/studio_availability_default") return "availability";
  return null;
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const table = tableFor(url);
    if (!table) {
      unexpected.push(`${req.method} ${url.pathname}`);
      res.writeHead(500);
      res.end();
      return;
    }
    reads.push(table);
    const answer = answers[table];
    if ("fail" in answer) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: "XX000",
          message: `injected ${table} failure`,
          details: null,
          hint: null,
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.rows));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `http://127.0.0.1:${port}`);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  answers = healthy();
  reads = [];
  unexpected = [];
});

const { renderToStaticMarkup } = await import("react-dom/server");
const PublicBookingPage = (await import("@/app/book/[slug]/page")).default;
const { UNAVAILABLE_PUBLIC_BOOKING_MESSAGE } = await import("@/lib/booking/readiness");

type Outcome =
  | { kind: "rendered"; html: string }
  | { kind: "not-found" }
  | { kind: "threw"; error: unknown };

async function visit(slug = "willow"): Promise<Outcome> {
  try {
    const element = await PublicBookingPage({ params: Promise.resolve({ slug }) });
    return { kind: "rendered", html: renderToStaticMarkup(element) };
  } catch (error) {
    if (error instanceof NotFoundSignal) return { kind: "not-found" };
    return { kind: "threw", error };
  } finally {
    expect(unexpected, "the page made a read this harness does not model").toEqual([]);
  }
}

function threwMessage(outcome: Outcome): string {
  expect(outcome.kind).toBe("threw");
  if (outcome.kind !== "threw") return "";
  expect(outcome.error).toBeInstanceOf(Error);
  return (outcome.error as Error).message;
}

describe("reads that COMPLETED may answer negatively", () => {
  it("a healthy, configured studio renders the booking form (the harness reaches the page)", async () => {
    const outcome = await visit();
    expect(outcome.kind).toBe("rendered");
    if (outcome.kind !== "rendered") return;
    expect(outcome.html).toContain('data-testid="public-book-form"');
    expect(outcome.html).toContain("Willow Studio");
    expect(outcome.html).not.toContain(UNAVAILABLE_PUBLIC_BOOKING_MESSAGE);
    expect(new Set(reads)).toEqual(new Set(["studio", "admission", "services", "availability"]));
  });

  it("a slug no studio has is a 404, and nothing else is read", async () => {
    answers.studio = OK([]);
    expect((await visit("no-such-studio")).kind).toBe("not-found");
    expect(reads).toEqual(["studio"]);
  });

  it("a studio with genuinely no active service still gets the setup notice", async () => {
    // The repair must not delete the legitimate negative: a COMPLETED read that
    // found nothing is a true statement about the studio's setup.
    answers.services = OK([]);
    const outcome = await visit();
    expect(outcome.kind).toBe("rendered");
    if (outcome.kind !== "rendered") return;
    expect(outcome.html).toContain(UNAVAILABLE_PUBLIC_BOOKING_MESSAGE);
  });

  it("a studio with genuinely no open day still gets the setup notice", async () => {
    answers.availability = OK([]);
    const outcome = await visit();
    expect(outcome.kind).toBe("rendered");
    if (outcome.kind !== "rendered") return;
    expect(outcome.html).toContain(UNAVAILABLE_PUBLIC_BOOKING_MESSAGE);
  });
});

describe("a read that FAILED answers nothing", () => {
  it("an unreadable studio throws to the boundary and is NOT reported as absent", async () => {
    answers.studio = FAIL;
    const outcome = await visit();
    expect(outcome.kind, "UNKNOWN must never become notFound()").not.toBe("not-found");
    expect(threwMessage(outcome)).toBe("Failed to load studio: injected studio failure");
  });

  it("a failed services read throws instead of claiming the studio has no services", async () => {
    answers.services = FAIL;
    const outcome = await visit();
    expect(outcome.kind, "rendered the setup notice from a failed read").not.toBe("rendered");
    expect(threwMessage(outcome)).toBe("Failed to load services: injected services failure");
  });

  it("a failed availability read throws instead of claiming the studio has no open day", async () => {
    answers.availability = FAIL;
    const outcome = await visit();
    expect(outcome.kind, "rendered the setup notice from a failed read").not.toBe("rendered");
    expect(threwMessage(outcome)).toBe(
      "Failed to load availability: injected availability failure",
    );
  });

  it("an unreadable ADMISSION mode keeps its own truthful surface (unchanged by this repair)", async () => {
    // getNewClientAdmissionMode already turns a failed read into `unknown`,
    // which has a surface of its own. The page must keep rendering it rather
    // than escalating to the error boundary.
    answers.admission = FAIL;
    const outcome = await visit();
    expect(outcome.kind).toBe("rendered");
    if (outcome.kind !== "rendered") return;
    expect(outcome.html).toContain('data-testid="public-book-form"');
    expect(outcome.html).not.toContain(UNAVAILABLE_PUBLIC_BOOKING_MESSAGE);
  });
});
