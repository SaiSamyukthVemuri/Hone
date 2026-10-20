import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// FETT photos (HON-43): GET /api/clients/[clientId]/images/[imageId]/signed-url,
// the photo-cell re-mint (Codex P1 4307807754 moved it off server actions).
//
// It returns signed URLs, so it must be NEVER WEAKER than the action it
// replaces for re-mints. Called DIRECTLY here, so these cases prove the
// handler's own defence in depth; the session middleware refuses the same
// requests earlier, and e2e/fett-photos-thumbnail-recovery.spec.ts proves that
// through the real middleware. Every refusal case has a positive control: the
// same request, made by the right owner for the right client, gets a URL.
//
// The table mock applies the signer's own query filters, so a dropped filter
// changes what it returns.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const OTHER_STUDIO = "99999999-9999-9999-9999-999999999999";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const OTHER_CLIENT = "55555555-5555-5555-5555-555555555555";
const PRACT = "44444444-4444-4444-4444-444444444444";
const IMG = "33333333-3333-3333-3333-333333333333";
const PATH = `${STUDIO}/${CLIENT}/${IMG}.png`;
const THUMB = `${STUDIO}/${CLIENT}/${IMG}.thumb.webp`;

type Row = {
  id: string;
  studio_id: string;
  client_id: string;
  storage_bucket: string;
  storage_path: string;
  deleted_at: string | null;
};
let table: Row[] = [];
let signedIn = true;
let practitioner = true;
const signed: string[] = [];

const alerts = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: vi.fn(async (a: unknown) => {
    alerts.calls.push(a);
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => {
    // The real helper redirects (anonymous) or throws (no active
    // practitioner: a receptionist, an uninvited account).
    if (!signedIn) throw new Error("NEXT_REDIRECT");
    if (!practitioner) throw new Error("No active practitioner found for the signed-in user.");
    return { practitioner: { id: PRACT, active: true }, studio: { id: STUDIO } };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: signedIn ? { id: "u1" } : null }, error: null })),
    },
    from: vi.fn(() => {
      const filters: Array<(r: Row) => boolean> = [];
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn((col: keyof Row, v: unknown) => {
        filters.push((r) => r[col] === v);
        return chain;
      });
      chain.is = vi.fn((col: keyof Row, v: unknown) => {
        filters.push((r) => r[col] === v);
        return chain;
      });
      chain.maybeSingle = vi.fn(async () => ({
        data: table.find((r) => filters.every((f) => f(r))) ?? null,
        error: null,
      }));
      return chain;
    }),
  })),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn(async (path: string) => {
          signed.push(path);
          return { data: { signedUrl: `https://storage.test/sign/${path}?token=t` }, error: null };
        }),
      })),
    },
  })),
}));

import { GET } from "@/app/api/clients/[clientId]/images/[imageId]/signed-url/route";

function row(over: Partial<Row> = {}): Row {
  return {
    id: IMG,
    studio_id: STUDIO,
    client_id: CLIENT,
    storage_bucket: "treatment-images",
    storage_path: PATH,
    deleted_at: null,
    ...over,
  };
}

async function call(clientId = CLIENT, imageId = IMG, variant: string | null = "thumb") {
  const q = variant === null ? "" : `?variant=${variant}`;
  const res = await GET(new NextRequest(`http://localhost/api/clients/${clientId}/images/${imageId}/signed-url${q}`), {
    params: Promise.resolve({ clientId, imageId }),
  });
  return { res, status: res.status, text: await res.text() };
}

beforeEach(() => {
  table = [row()];
  signedIn = true;
  practitioner = true;
  signed.length = 0;
  alerts.calls.length = 0;
});

describe("positive controls", () => {
  it("the owner gets a fresh DERIVATIVE URL for their own client's photo", async () => {
    const { status, text } = await call(CLIENT, IMG, "thumb");
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ url: `https://storage.test/sign/${THUMB}?token=t` });
    expect(signed).toEqual([PATH, THUMB]); // authorization ceiling: the original signs first
  });

  it("…and the ORIGINAL with variant=original", async () => {
    const { status, text } = await call(CLIENT, IMG, "original");
    expect(status).toBe(200);
    expect(JSON.parse(text)).toEqual({ url: `https://storage.test/sign/${PATH}?token=t` });
  });
});

describe("refusals (each paired with the control above)", () => {
  it("UNAUTHENTICATED → 401 JSON, nothing signed", async () => {
    signedIn = false;
    const { status, text } = await call();
    expect(status).toBe(401);
    expect(JSON.parse(text)).toEqual({ error: "unauthenticated" });
    expect(signed).toEqual([]);
  });

  it("signed in with NO active practitioner (a receptionist) → 403 JSON, nothing signed", async () => {
    practitioner = false;
    const { status, text } = await call();
    expect(status).toBe(403);
    expect(JSON.parse(text)).toEqual({ error: "forbidden" });
    expect(signed).toEqual([]);
  });

  it("CROSS-STUDIO: another studio's photo → 404, nothing signed", async () => {
    table = [row({ studio_id: OTHER_STUDIO, storage_path: `${OTHER_STUDIO}/${CLIENT}/${IMG}.png` })];
    expect((await call()).status).toBe(404);
    expect(signed).toEqual([]);
  });

  it("CROSS-CLIENT: a photo of another client in the SAME studio → 404 (control: its own client → 200)", async () => {
    table = [row({ client_id: OTHER_CLIENT, storage_path: `${STUDIO}/${OTHER_CLIENT}/${IMG}.png` })];
    expect((await call(CLIENT)).status).toBe(404);
    expect(signed).toEqual([]);
    expect((await call(OTHER_CLIENT)).status).toBe(200);
  });

  it("PATH/PARAM MISMATCH: the stored path's client segment is not the requested client → 404, nothing signed", async () => {
    table = [row({ storage_path: `${STUDIO}/${OTHER_CLIENT}/${IMG}.png` })];
    expect((await call(CLIENT)).status).toBe(404);
    expect(signed).toEqual([]);
  });

  it("ARCHIVED → 404; MISSING → 404; MALFORMED ids → 404", async () => {
    table = [row({ deleted_at: "2026-10-17T00:00:00Z" })];
    expect((await call()).status).toBe(404);
    table = [];
    expect((await call()).status).toBe(404);
    table = [row()];
    expect((await call("not-a-uuid", IMG)).status).toBe(404);
    expect((await call(CLIENT, "not-a-uuid")).status).toBe(404);
    expect(signed).toEqual([]);
  });

  it("a variant other than thumb/original → 400", async () => {
    expect((await call(CLIENT, IMG, "full")).status).toBe(400);
    expect((await call(CLIENT, IMG, null)).status).toBe(400);
    expect(signed).toEqual([]);
  });
});

describe("no oracle, no cache, no CORS, no logged secrets", () => {
  it("missing, cross-studio, cross-client, path-mismatch and archived 404s are BYTE-IDENTICAL", async () => {
    const bodies: string[] = [];
    table = [];
    bodies.push((await call()).text);
    table = [row({ studio_id: OTHER_STUDIO, storage_path: `${OTHER_STUDIO}/${CLIENT}/${IMG}.png` })];
    bodies.push((await call()).text);
    table = [row({ client_id: OTHER_CLIENT, storage_path: `${STUDIO}/${OTHER_CLIENT}/${IMG}.png` })];
    bodies.push((await call()).text);
    table = [row({ storage_path: `${STUDIO}/${OTHER_CLIENT}/${IMG}.png` })];
    bodies.push((await call()).text);
    table = [row({ deleted_at: "2026-10-17T00:00:00Z" })];
    bodies.push((await call()).text);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: "Image not available." });
  });

  it("EVERY response, success or refusal, is no-store and carries no Access-Control-* header", async () => {
    const responses: Response[] = [];
    responses.push((await call()).res); // 200
    responses.push((await call(CLIENT, IMG, "x")).res); // 400
    table = [];
    responses.push((await call()).res); // 404
    practitioner = false;
    responses.push((await call()).res); // 403
    signedIn = false;
    responses.push((await call()).res); // 401
    expect(responses.map((r) => r.status)).toEqual([200, 400, 404, 403, 401]);
    for (const r of responses) {
      expect(r.headers.get("cache-control")).toBe("no-store, private");
      expect([...r.headers.keys()].filter((k) => k.toLowerCase().startsWith("access-control-"))).toEqual([]);
    }
  });

  it("never logs a signed URL or a storage path (console, ops alerts) on success or on a rejected path", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      await call(); // success: a signed URL exists in memory
      table = [row({ storage_path: `${STUDIO}/${OTHER_CLIENT}/${IMG}.png` })];
      await call(); // rejected path: raises an ops alert
      expect(alerts.calls.length).toBe(1);
      const logged = JSON.stringify([...spies.flatMap((s) => s.mock.calls), alerts.calls]);
      expect(logged).not.toMatch(/storage\.test|token=|\.png|\.webp/);
      expect(logged).not.toContain(`${STUDIO}/`);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
