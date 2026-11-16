import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TOKEN_ROUTE_PATTERNS } from "@/lib/security/token-routes";
import { buildTokenRoutePrivacyHeaders } from "@/lib/security/headers";
import { redactVercelEvent } from "@/lib/analytics/vercel-url-redaction";
import { resetInProcessTicketStore } from "@/lib/records/print/ticket-store";

// The print flow from the POST to the page. Synthetic ids, a synthetic secret, no network, no database.
const SECRET = "synthetic-print-ticket-secret-0123456789abcdef";
const STUDIO = "11111111-1111-4111-8111-111111111111";
const OTHER_STUDIO = "33333333-3333-4333-8333-333333333333";
const OWNER = "22222222-2222-4222-8222-222222222222";
const CLIENT = "7c1d2e3f-4a5b-4c6d-8e7f-a1b2c3d4e5f6";
const DAY = "2020-02-17"; // long past, so "today" never matters
const ORIGIN = "https://hone.test";

const state = vi.hoisted(() => ({
  who: { practitioner: { id: "", role: "owner", active: true }, studio: { id: "", timezone: "America/Toronto" } } as {
    practitioner: { id: string; role: string; active: boolean }; studio: { id: string; timezone: string };
  },
  throwIdentity: false,
  viewCalls: [] as Array<{ clientId?: unknown; day?: unknown }>,
}));

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => {
    if (state.throwIdentity) throw new Error("NEXT_REDIRECT");
    return state.who;
  },
}));
vi.mock("@/app/(app)/records/print/_packet/day-packet-view", () => ({
  DayPacketView: (props: { clientId?: unknown; day?: unknown }) => {
    state.viewCalls.push(props);
    return null;
  },
}));

const { POST, ...routeModule } = await import("@/app/(app)/records/print/open/route");
const pageModule = await import("@/app/(app)/records/print/ticket/[token]/page");
const TicketPage = pageModule.default;

function post(fields: Record<string, string>, headers: Record<string, string> = { origin: ORIGIN }) {
  const body = new URLSearchParams(fields);
  return POST(new Request(`${ORIGIN}/records/print/open`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", host: "hone.test", ...headers } }));
}
const location = (r: Response) => r.headers.get("location") ?? "";
const ticketOf = (r: Response) => new URL(location(r), ORIGIN).pathname.split("/").pop()!;
const everything = (r: Response) => JSON.stringify([...r.headers.entries()]);
const ID_PATTERNS = [CLIENT, CLIENT.replace(/-/g, ""), DAY, DAY.replace(/-/g, ""), "clientId", "day="];

beforeEach(() => {
  process.env.PRINT_TICKET_SECRET = SECRET;
  state.who = { practitioner: { id: OWNER, role: "owner", active: true }, studio: { id: STUDIO, timezone: "America/Toronto" } };
  state.throwIdentity = false;
  state.viewCalls.length = 0;
  resetInProcessTicketStore();
});

describe("the POST mints a ticket and redirects with no identifier in the Location or any response header", () => {
  it("answers 303 to /records/print/ticket/<opaque>, and neither Location nor any header holds the client id or the day", async () => {
    const r = await post({ clientId: CLIENT, day: DAY });
    expect(r.status).toBe(303);
    expect(location(r)).toMatch(/^\/records\/print\/ticket\/[A-Za-z0-9_-]{127}$/);
    expect(new URL(location(r), ORIGIN).search).toBe("");
    expect(new URL(location(r), ORIGIN).hash).toBe("");
    for (const needle of ID_PATTERNS) expect(everything(r), needle).not.toContain(needle);
    expect(location(r)).not.toContain(OWNER);
    expect(location(r)).not.toContain(STUDIO);
  });
  it("the response is not cached, not indexed and carries no referrer", async () => {
    const r = await post({ clientId: CLIENT, day: DAY });
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await r.text()).toBe("");
  });
  it("only POST is exported, so a GET (which could carry the values in a URL) is a 405", () => {
    expect(Object.keys(routeModule).filter((k) => ["GET", "PUT", "PATCH", "DELETE", "HEAD"].includes(k))).toEqual([]);
  });
});

describe("the 303 itself carries no-referrer, so the redirected GET sends no Referer", () => {
  it("a minted ticket's 303 response has Referrer-Policy: no-referrer, no-store and noindex", async () => {
    const r = await post({ clientId: CLIENT, day: DAY });
    expect(r.status).toBe(303);
    expect(location(r)).toContain("/records/print/ticket/");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toContain("noindex");
  });
  it("so does every refusal 303", async () => {
    const r = await post({ clientId: CLIENT, day: DAY }, { origin: "https://evil.test" });
    expect(r.status).toBe(303);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("the route is in the registry, so the global header rule also gives its path no-referrer (not the platform default)", async () => {
    const { TOKEN_ROUTE_PATTERNS } = await import("@/lib/security/token-routes");
    expect(TOKEN_ROUTE_PATTERNS).toContain("/records/print/open/:token*");
  });
});

describe("the Location is relative, so it never depends on request.url's host", () => {
  it("a minted 303 and a refusal 303 are plain paths", async () => {
    const ok = await post({ clientId: CLIENT, day: DAY });
    expect(location(ok)).toMatch(/^\/records\/print\/ticket\/[A-Za-z0-9_-]{127}$/);
    const no = await post({ clientId: CLIENT, day: DAY }, { origin: "https://evil.test" });
    expect(location(no)).toBe("/records");
  });
  it("the same Location comes back whatever host request.url carries (a proxy's internal host)", async () => {
    for (const url of ["https://hone.test", "http://localhost:3000", "http://app.internal.test:8080"]) {
      const body = new URLSearchParams({ clientId: CLIENT, day: DAY });
      const r = await POST(new Request(`${url}/records/print/open`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", host: "hone.test", origin: ORIGIN } }));
      expect(location(r), url).toMatch(/^\/records\/print\/ticket\/[A-Za-z0-9_-]{127}$/);
      const bad = await POST(new Request(`${url}/records/print/open`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", host: "hone.test", origin: "https://evil.test" } }));
      expect(location(bad), url).toBe("/records");
    }
  });
});

describe("the registry entry for the open route is exact, and analytics dropping it is intended", () => {
  it("the header pattern matches the route and its suffixes, not a sibling path such as /records/print/opener", async () => {
    const { pathToRegexp } = await import("next/dist/compiled/path-to-regexp");
    const re = pathToRegexp("/records/print/open/:token*");
    expect(re.test("/records/print/open")).toBe(true);
    expect(re.test("/records/print/open/x")).toBe(true);
    for (const sibling of ["/records/print/opener", "/records/print/opened/x", "/records/print/open-all", "/records/print/day"]) {
      expect(re.test(sibling), sibling).toBe(false);
    }
  });
  it("the telemetry scrubber's matcher also leaves a sibling alone", async () => {
    const { canonicalizeTokenPaths } = await import("@/lib/security/token-routes");
    expect(canonicalizeTokenPaths("GET /records/print/opener/abc")).toBe("GET /records/print/opener/abc");
    expect(canonicalizeTokenPaths("POST /records/print/open/abc")).not.toContain("abc");
  });
  it("analytics drops an event for the open route (intended: its path is the minting step) and keeps a sibling's", () => {
    expect(redactVercelEvent({ url: `${ORIGIN}/records/print/open` })).toBeNull();
    expect(redactVercelEvent({ url: `${ORIGIN}/records/print/opener` })).not.toBeNull();
  });
});

describe("older browsers without Sec-Fetch-Site (older Safari): the same-host Origin decides", () => {
  it("a real same-host Origin is accepted: the form has no rel=noreferrer, so Safari sends its real Origin", async () => {
    const r = await post({ clientId: CLIENT, day: DAY }, { origin: ORIGIN });
    expect(r.status).toBe(303);
    expect(location(r)).toContain("/records/print/ticket/");
  });
  it("'Origin: null', another host, a look-alike host and a different port are refused", async () => {
    for (const origin of ["null", "https://evil.test", "https://hone.test.evil.test", "https://hone.test:8443", "http://evil.test@hone.test", ""]) {
      const r = await post({ clientId: CLIENT, day: DAY }, { origin });
      expect(new URL(location(r), ORIGIN).pathname, origin).toBe("/records");
    }
  });
});

describe("the body is read only after identity and the owner gate (a stranger's form is never parsed)", () => {
  const spy = () => {
    const req = new Request(`${ORIGIN}/records/print/open`, {
      method: "POST", body: new URLSearchParams({ clientId: CLIENT, day: DAY }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, host: "hone.test" },
    });
    return { req, formData: vi.spyOn(req, "formData") };
  };
  it("no identity, a non-owner and an inactive owner: formData is never called", async () => {
    state.throwIdentity = true;
    let s = spy(); await POST(s.req); expect(s.formData).not.toHaveBeenCalled();
    state.throwIdentity = false;
    for (const practitioner of [{ id: OWNER, role: "practitioner", active: true }, { id: OWNER, role: "owner", active: false }]) {
      state.who = { ...state.who, practitioner };
      s = spy(); await POST(s.req); expect(s.formData).not.toHaveBeenCalled();
    }
  });
  it("a cross-origin request is refused before the body too", async () => {
    const req = new Request(`${ORIGIN}/records/print/open`, { method: "POST", body: new URLSearchParams({ clientId: CLIENT }), headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" } });
    const formData = vi.spyOn(req, "formData");
    await POST(req);
    expect(formData).not.toHaveBeenCalled();
  });
  it("the owner's request does read it (anti-vacuity)", async () => {
    const s = spy(); await POST(s.req); expect(s.formData).toHaveBeenCalledTimes(1);
  });
});

describe("the POST refuses without minting, and never says why", () => {
  const refused = async (r: Response) => {
    expect(r.status).toBe(303);
    expect(new URL(location(r), ORIGIN).pathname).toBe("/records"); // the same place for every refusal
    expect(new URL(location(r), ORIGIN).search).toBe("");
    for (const needle of ID_PATTERNS) expect(everything(r), needle).not.toContain(needle);
  };
  it("a non-owner, an inactive owner", async () => {
    for (const practitioner of [{ id: OWNER, role: "practitioner", active: true }, { id: OWNER, role: "receptionist", active: true }, { id: OWNER, role: "owner", active: false }]) {
      state.who = { ...state.who, practitioner };
      await refused(await post({ clientId: CLIENT, day: DAY }));
    }
  });
  it("no signed-in identity (the identity helper throws)", async () => {
    state.throwIdentity = true;
    await refused(await post({ clientId: CLIENT, day: DAY }));
  });
  it("a cross-origin, cross-site or origin-less POST", async () => {
    await refused(await post({ clientId: CLIENT, day: DAY }, { origin: "https://evil.test" }));
    await refused(await post({ clientId: CLIENT, day: DAY }, {}));
    await refused(await post({ clientId: CLIENT, day: DAY }, { origin: "null" }));
    await refused(await post({ clientId: CLIENT, day: DAY }, { origin: ORIGIN, "sec-fetch-site": "cross-site" })); // the browser's word wins
    await refused(await post({ clientId: CLIENT, day: DAY }, { origin: ORIGIN, "sec-fetch-site": "same-site" }));
    await refused(await post({ clientId: CLIENT, day: DAY }, { origin: ORIGIN, "sec-fetch-site": "none" }));
  });
  it("a browser that sends Sec-Fetch-Site: same-origin is accepted even with 'Origin: null' (the header vouches for it)", async () => {
    const r = await post({ clientId: CLIENT, day: DAY }, { origin: "null", "sec-fetch-site": "same-origin" });
    expect(r.status).toBe(303);
    expect(location(r)).toContain("/records/print/ticket/");
  });
  it("a bad client id, a missing or unreal day, a future day and a day outside 1900-2100", async () => {
    for (const fields of [
      { clientId: "nope", day: DAY }, { clientId: "", day: DAY }, { day: DAY }, { clientId: CLIENT }, { clientId: CLIENT, day: "2020-02-30" },
      { clientId: CLIENT, day: "2999-01-01" }, { clientId: CLIENT, day: "1850-01-01" }, { clientId: CLIENT, day: "x" },
    ]) await refused(await post(fields as Record<string, string>));
  });
  it("a missing or short secret mints nothing", async () => {
    for (const secret of [undefined, "short"]) {
      if (secret === undefined) delete process.env.PRINT_TICKET_SECRET; else process.env.PRINT_TICKET_SECRET = secret;
      await refused(await post({ clientId: CLIENT, day: DAY }));
    }
  });
});

describe("the ticket page resolves it on the server and renders the packet once", () => {
  const render = async (token: string) => renderToStaticMarkup((await TicketPage({ params: Promise.resolve({ token }) })) as never);
  it("the owner who asked gets the packet view with the client and day, which never appear in the markup of the route", async () => {
    const token = ticketOf(await post({ clientId: CLIENT, day: DAY }));
    await render(token);
    expect(state.viewCalls).toEqual([{ clientId: CLIENT, day: DAY }]);
  });
  it("a reused ticket is refused with no packet", async () => {
    const token = ticketOf(await post({ clientId: CLIENT, day: DAY }));
    await render(token);
    state.viewCalls.length = 0;
    const html = await render(token);
    expect(state.viewCalls).toEqual([]);
    expect(html).toContain("no longer valid");
    expect(html).toContain("No clinical record is shown");
  });
  it("a ticket from another studio, or another owner of the same studio, is refused with no packet", async () => {
    const token = ticketOf(await post({ clientId: CLIENT, day: DAY }));
    state.who = { ...state.who, studio: { id: OTHER_STUDIO, timezone: "America/Toronto" } };
    expect(await render(token)).toContain("no longer valid");
    state.who = { practitioner: { id: "44444444-4444-4444-8444-444444444444", role: "owner", active: true }, studio: { id: STUDIO, timezone: "America/Toronto" } };
    expect(await render(token)).toContain("no longer valid");
    expect(state.viewCalls).toEqual([]);
  });
  it("an expired ticket is refused (clock moved past five minutes)", async () => {
    const token = ticketOf(await post({ clientId: CLIENT, day: DAY }));
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(Date.now() + 5 * 60 * 1000 + 1000));
      expect(await render(token)).toContain("no longer valid");
    } finally { vi.useRealTimers(); }
    expect(state.viewCalls).toEqual([]);
  });
  it("a made-up, empty or oversize token is refused, and a missing secret opens nothing", async () => {
    for (const token of ["", "x", "A".repeat(127), "A".repeat(400), CLIENT]) expect(await render(token), token).toContain("no longer valid");
    const good = ticketOf(await post({ clientId: CLIENT, day: DAY }));
    delete process.env.PRINT_TICKET_SECRET;
    expect(await render(good)).toContain("no longer valid");
    expect(state.viewCalls).toEqual([]);
  });
  it("a refusal's markup contains no identifier and names no reason", async () => {
    const html = await render("A".repeat(127));
    for (const needle of [CLIENT, DAY, "expired", "foreign", "forged"]) expect(html).not.toContain(needle);
  });
});

describe("no identifier is in a URL, a Referer or an analytics event on this route, and Sentry events are scrubbed", () => {
  it("the ticket route is in the token registry, so it gets no-referrer and noindex headers", () => {
    expect(TOKEN_ROUTE_PATTERNS).toContain("/records/print/ticket/:token*");
    const headers = Object.fromEntries(buildTokenRoutePrivacyHeaders().map((h) => [h.key, h.value]));
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
    expect(headers["X-Robots-Tag"]).toMatch(/noindex/);
    expect(readFileSync("next.config.ts", "utf8")).toContain("TOKEN_ROUTE_PATTERNS.map");
  });
  it("Vercel Analytics and Speed Insights drop the page's event instead of sending its path", () => {
    expect(redactVercelEvent({ url: `${ORIGIN}/records/print/ticket/${"A".repeat(127)}` })).toBeNull();
  });
  it("the page route sets its own no-referrer metadata as well", () => {
    expect(pageModule.metadata).toMatchObject({ referrer: "no-referrer", robots: { index: false, follow: false } });
    expect(pageModule.dynamic).toBe("force-dynamic");
  });
  it("no source in the print flow builds a clientId or day query string or path", () => {
    const files = [
      "app/(app)/records/print/open/route.ts", "app/(app)/records/print/ticket/[token]/page.tsx", "app/(app)/records/print/day/page.tsx",
      "app/(app)/records/print/_packet/day-packet-view.tsx", "app/(app)/records/print/day/print-button.tsx", "lib/records/print/day-entry.ts",
      "lib/records/print/ticket.ts", "lib/records/print/ticket-resolve.ts", "lib/records/print/ticket-store.ts",
    ];
    for (const f of files) {
      const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
      expect(code, f).not.toMatch(/[?&]clientId=|[?&]day=|URLSearchParams\(\{[^}]*(clientId|day)|`[^`]*\$\{[^}]*(clientId|day)[^}]*\}[^`]*`\s*(\)|,)?\s*\/\/?\s*href/);
      expect(code, f).not.toMatch(/console\.|@sentry|captureException|posthog/i);
    }
  });
});
