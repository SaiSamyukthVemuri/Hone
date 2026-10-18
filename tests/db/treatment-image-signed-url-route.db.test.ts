import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  E2E_SERVICE_ROLE_KEY,
  E2E_SUPABASE_URL,
  E2E_WEB_SERVER_ENV,
} from "@/e2e/helpers/local-env";
import { adminQuery, closePool, seedStudio, type SeededStudio } from "@/tests/db/helpers/harness";

// FETT photos (HON-43): GET /api/clients/[clientId]/images/[imageId]/signed-url
// against the REAL local database, RLS and storage: the endpoint returns signed
// URLs, so its refusals are proved with real rows, real sessions and the real
// signer — not a mock of them. Each refusal is paired with a POSITIVE CONTROL:
// the same image, asked for by its own studio's owner for its own client, gets
// a URL from this very stack.
//
// The handler is called directly, with the caller's REAL Supabase session in
// the cookie jar. The session middleware (which refuses logged-out and
// no-practitioner callers even earlier) is proved through the real request
// path by e2e/fett-photos-thumbnail-recovery.spec.ts.
//
// NEEDS storage-api (the signer signs real objects). CI's database lane starts
// Supabase without it, so this suite SKIPS there, loudly, rather than passing
// its refusal cases without their controls.

if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

const ANON = E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
  }),
}));
// Not the subject; keeps a rejected-path alert from reaching any sink.
const alerts = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: vi.fn(async (a: unknown) => {
    alerts.push(a);
  }),
}));

const STORAGE_UP = await fetch(`${E2E_SUPABASE_URL}/storage/v1/version`).then(
  (r) => r.ok,
  () => false,
);

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

type GET = typeof import("@/app/api/clients/[clientId]/images/[imageId]/signed-url/route").GET;
let GET_: GET;

let A: SeededStudio;
let B: SeededStudio;
let clientA2: string;
const users: Record<"ownerA" | "ownerB" | "noPractitioner", { email: string; password: string }> = {} as never;
const img = { a1: randomUUID(), a2: randomUUID(), b1: randomUUID(), archived: randomUUID(), mismatch: randomUUID() };

async function upload(path: string) {
  const r = await fetch(`${E2E_SUPABASE_URL}/storage/v1/object/treatment-images/${path}`, {
    method: "POST",
    headers: {
      apikey: E2E_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
      "Content-Type": "image/png",
      "x-upsert": "true",
    },
    body: PNG,
  });
  if (!r.ok) throw new Error(`storage upload failed: ${r.status}`);
}

async function insertImage(id: string, studioId: string, clientId: string, path: string, archived = false) {
  await adminQuery(
    `insert into public.treatment_images
       (id, studio_id, client_id, storage_bucket, storage_path, original_filename, content_type, size_bytes, deleted_at)
     values ($1, $2, $3, 'treatment-images', $4, 'synthetic.png', 'image/png', $5, ${archived ? "now()" : "null"})`,
    [id, studioId, clientId, path, PNG.length],
  );
}

async function createAuthUser(label: string) {
  const email = `${label}-${randomUUID().slice(0, 8)}@harness.local`;
  const password = `Pw-${randomUUID()}`;
  const created = await fetch(`${E2E_SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: E2E_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${E2E_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`local GoTrue createUser failed: ${created.status}`);
  const { id } = (await created.json()) as { id: string };
  return { id, email, password };
}

/** Put `who`'s REAL session in the cookie jar (or none). */
async function as(who: keyof typeof users | "anonymous") {
  jar.clear();
  if (who === "anonymous") return;
  const { email, password } = users[who];
  const token = await fetch(`${E2E_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: ANON, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!token.ok) throw new Error(`local sign-in failed: ${token.status}`);
  const s = (await token.json()) as { access_token: string; refresh_token: string };
  const writer = createServerClient(E2E_SUPABASE_URL, ANON, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) => list.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  await writer.auth.setSession({ access_token: s.access_token, refresh_token: s.refresh_token });
  if (jar.size === 0) throw new Error("no auth cookie was written");
}

async function call(clientId: string, imageId: string, variant = "original") {
  const res = await GET_(
    new NextRequest(`http://localhost/api/clients/${clientId}/images/${imageId}/signed-url?variant=${variant}`),
    { params: Promise.resolve({ clientId, imageId }) },
  );
  const text = await res.text();
  return { status: res.status, text, res };
}

describe.skipIf(!STORAGE_UP)("signed-url route on the real stack (needs storage-api)", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;

    A = await seedStudio(`signurl-a-${randomUUID().slice(0, 6)}`);
    B = await seedStudio(`signurl-b-${randomUUID().slice(0, 6)}`);
    clientA2 = randomUUID();
    await adminQuery(`insert into public.clients (id, studio_id, name) values ($1, $2, 'Client A2')`, [clientA2, A.studioId]);

    for (const [key, studio] of [
      ["ownerA", A],
      ["ownerB", B],
    ] as const) {
      const u = await createAuthUser(key);
      await adminQuery("update public.practitioners set user_id = $2, email = $3 where id = $1", [
        studio.practitionerId,
        u.id,
        u.email,
      ]);
      users[key] = u;
    }
    // Signed in, but no practitioner row anywhere: how a receptionist or an
    // uninvited account reaches this handler.
    users.noPractitioner = await createAuthUser("nopract");

    const pA1 = `${A.studioId}/${A.clientId}/${img.a1}.png`;
    const pA2 = `${A.studioId}/${clientA2}/${img.a2}.png`;
    const pB1 = `${B.studioId}/${B.clientId}/${img.b1}.png`;
    const pArch = `${A.studioId}/${A.clientId}/${img.archived}.png`;
    // A row of client A1 whose stored path sits under client A2: the object
    // EXISTS there, so only the path/param binding can refuse it.
    const pMis = `${A.studioId}/${clientA2}/${img.mismatch}.png`;
    for (const p of [pA1, `${A.studioId}/${A.clientId}/${img.a1}.thumb.webp`, pA2, pB1, pArch, pMis]) await upload(p);
    await insertImage(img.a1, A.studioId, A.clientId, pA1);
    await insertImage(img.a2, A.studioId, clientA2, pA2);
    await insertImage(img.b1, B.studioId, B.clientId, pB1);
    await insertImage(img.archived, A.studioId, A.clientId, pArch, true);
    await insertImage(img.mismatch, A.studioId, A.clientId, pMis);

    GET_ = (await import("@/app/api/clients/[clientId]/images/[imageId]/signed-url/route")).GET;
  }, 120_000);

  afterAll(async () => {
    await closePool();
  });

  it("POSITIVE CONTROL: the owner gets real signed URLs (original and derivative) for their own client's photo", async () => {
    await as("ownerA");
    const o = await call(A.clientId, img.a1, "original");
    expect(o.status).toBe(200);
    expect(JSON.parse(o.text).url).toContain(`/object/sign/treatment-images/${A.studioId}/${A.clientId}/${img.a1}.png`);
    const t = await call(A.clientId, img.a1, "thumb");
    expect(t.status).toBe(200);
    expect(JSON.parse(t.text).url).toContain(`${img.a1}.thumb.webp`);
    // ...and the URL really serves the object.
    expect((await fetch(JSON.parse(o.text).url)).status).toBe(200);
  });

  it("CROSS-STUDIO: studio A's owner gets 404 for studio B's photo; studio B's owner gets it (control)", async () => {
    await as("ownerA");
    expect((await call(B.clientId, img.b1)).status).toBe(404);
    expect((await call(A.clientId, img.b1)).status).toBe(404);
    await as("ownerB");
    expect((await call(B.clientId, img.b1)).status).toBe(200);
  });

  it("CROSS-CLIENT: a photo of another client in the SAME studio is 404 under the wrong client, 200 under its own", async () => {
    await as("ownerA");
    expect((await call(A.clientId, img.a2)).status).toBe(404);
    expect((await call(clientA2, img.a2)).status).toBe(200);
  });

  it("PATH/PARAM MISMATCH: a row whose stored path names another client is 404 under either client, though the object exists", async () => {
    await as("ownerA");
    alerts.length = 0;
    expect((await call(A.clientId, img.mismatch)).status).toBe(404);
    expect((await call(clientA2, img.mismatch)).status).toBe(404);
    expect(alerts.length).toBe(1); // the rejected path is reported (once: the other call never found the row)
  });

  it("ARCHIVED: 404 for the owner, though its object exists", async () => {
    await as("ownerA");
    expect((await call(A.clientId, img.archived)).status).toBe(404);
  });

  it("UNAUTHENTICATED: 401 (the control above used the same image)", async () => {
    await as("anonymous");
    const r = await call(A.clientId, img.a1);
    expect(r.status).toBe(401);
    expect(r.text).not.toMatch(/sign\/|token=/);
  });

  it("SIGNED IN, NO PRACTITIONER (a receptionist): 403 (control above)", async () => {
    await as("noPractitioner");
    const r = await call(A.clientId, img.a1);
    expect(r.status).toBe(403);
    expect(r.text).not.toMatch(/sign\/|token=/);
  });

  it("every 404 is byte-identical, and every response is no-store with no CORS header", async () => {
    await as("ownerA");
    const refusals = [
      await call(B.clientId, img.b1),
      await call(A.clientId, img.a2),
      await call(A.clientId, img.mismatch),
      await call(A.clientId, img.archived),
      await call(A.clientId, randomUUID()),
    ];
    expect(new Set(refusals.map((r) => `${r.status} ${r.text}`)).size).toBe(1);
    expect(refusals[0].status).toBe(404);
    for (const r of [...refusals, await call(A.clientId, img.a1)]) {
      expect(r.res.headers.get("cache-control")).toBe("no-store, private");
      expect([...r.res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    }
  });
});
