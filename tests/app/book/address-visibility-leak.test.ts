import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// HON-50. An address marked EMAILS-ONLY (the visibility column is drafted, not
// yet applied; the harness serves rows that carry it, as they will) must not reach anything
// the public booking page sends to a visitor: its HTML, the props it hands to
// the client form (the RSC payload), or its metadata. The real page function
// runs against a loopback server playing PostgREST through the real
// createAdminClient (harness from public-booking-read-failure.test.ts). The
// page exports no metadata/generateMetadata and renders no JSON-LD; the
// source guard at the end keeps it that way, and keeps the page reading the
// address only through publicBookingAddress(). All values are synthetic.

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
// The form is a CLIENT component: every prop it receives is serialized into
// the page's RSC payload. The stand-in records them verbatim, so the leak
// assertions below see exactly what would cross to the browser.
const formProps = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/app/book/[slug]/PublicBookForm", async () => {
  const react = await import("react");
  return {
    PublicBookForm: (props: Record<string, unknown>) => {
      formProps.push(props);
      return react.createElement("div", { "data-testid": "public-book-form" });
    },
  };
});

type Answer = { rows: unknown[] } | { fail: true };
type Table = "studio" | "admission" | "services" | "availability";

const OK = (rows: unknown[]): Answer => ({ rows });

const STUDIO = {
  id: "studio-1",
  slug: "willow",
  name: "Willow Studio",
  timezone: "America/Toronto",
  public_booking_horizon_months: 3,
  booking_description: null,
  address: null as string | null,
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
  formProps.length = 0;
  answers = healthy();
  reads = [];
  unexpected = [];
});

const { renderToStaticMarkup } = await import("react-dom/server");
const PublicBookingPage = (await import("@/app/book/[slug]/page")).default;

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

const ADDRESS = "100 Synthetic Hidden Lane, Toronto ON";

function studioWith(fields: Record<string, unknown>) {
  answers.studio = OK([{ ...STUDIO, ...fields }]);
}

async function rendered(): Promise<{ html: string; props: string }> {
  const outcome = await visit();
  expect(outcome.kind).toBe("rendered");
  if (outcome.kind !== "rendered") return { html: "", props: "" };
  expect(formProps).toHaveLength(1);
  return { html: outcome.html, props: JSON.stringify(formProps) };
}

describe("an emails-only address never reaches the public booking page", () => {
  it("emails: absent from the HTML and from every prop handed to the client form", async () => {
    studioWith({ address: ADDRESS, address_visibility: "emails" });
    const { html, props } = await rendered();
    expect(html).not.toContain("Synthetic Hidden Lane");
    expect(props).not.toContain("Synthetic Hidden Lane");
    expect(formProps[0].studioAddress).toBeNull();
  });

  it("emails: arrival instructions are not rendered on the page either", async () => {
    studioWith({ address: ADDRESS, address_visibility: "emails", arrival_instructions: "Synthetic buzzer 7" });
    const { html, props } = await rendered();
    expect(html).not.toContain("Synthetic buzzer 7");
    expect(props).not.toContain("Synthetic buzzer 7");
  });

  it.each(["both", "booking_page"])("%s: the address is shown and handed to the form", async (v) => {
    studioWith({ address: ADDRESS, address_visibility: v });
    const { html } = await rendered();
    expect(html).toContain(ADDRESS);
    expect(formProps[0].studioAddress).toBe(ADDRESS);
  });

  it("a row from before the migration (no visibility column) shows the address, as today", async () => {
    studioWith({ address: ADDRESS });
    const { html } = await rendered();
    expect(html).toContain(ADDRESS);
    expect(formProps[0].studioAddress).toBe(ADDRESS);
  });

  it("a blank address stays absent", async () => {
    studioWith({ address: "   ", address_visibility: "both" });
    await rendered();
    expect(formProps[0].studioAddress).toBeNull();
  });
});

describe("source guards for the public booking tree", () => {
  const dir = "app/book/[slug]";
  const files = readdirSync(dir).filter((f: string) => /\.tsx?$/.test(f));

  it("the page renders only the forPublicBookingPage() view of the studio row", () => {
    const page = readFileSync(`${dir}/page.tsx`, "utf8").replace(/\/\/.*$/gm, "");
    expect(page).toMatch(/const studio = forPublicBookingPage\(studioRow\);/);
    // The raw row is used for nothing but the not-found check and the view.
    expect(page.match(/\bstudioRow\b/g)).toHaveLength(3);
  });

  it("no file in the public booking tree exports metadata or JSON-LD", () => {
    for (const f of files) {
      const src = readFileSync(`${dir}/${f}`, "utf8");
      expect(src, f).not.toMatch(/generateMetadata|export const metadata|ld\+json|openGraph/);
    }
  });

  it("no file in the public booking tree reads arrival_instructions", () => {
    for (const f of files) {
      expect(readFileSync(`${dir}/${f}`, "utf8"), f).not.toMatch(/arrival_instructions/);
    }
  });
});
