import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An ISOLATED local stack is selected as a PAIR: E2E_SUPABASE_URL (API + GoTrue)
// and HONE_LOCAL_DB_URL (Postgres). Before this, tests/db's 66 PostgREST/GoTrue
// reads went to the shared 54321 stack while its pg pool followed
// HONE_LOCAL_DB_URL, and a split-target run wrote auth users into the wrong stack.
// The mirror image (app isolated, e2e fixtures seeding the shared 54322 through
// E2E_DB_URL) would be a green run against the wrong database. So the controls
// are: an off-machine value still throws, and a HALF-moved pair is refused.
//
// local-env refuses at IMPORT, and the unit lane sets NEXT_PUBLIC_SUPABASE_URL to
// a hosted-looking placeholder for the build, so every guarded name is cleared
// before each fresh import and restored afterwards.
const GUARDED = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL", "HONE_LOCAL_DB_URL", "E2E_SUPABASE_URL"];
const ISO_API = "http://127.0.0.1:63321";
const ISO_DB = "postgresql://postgres:postgres@127.0.0.1:63322/postgres";

async function importWith(supabaseUrl: string, dbUrl = "") {
  for (const name of GUARDED) vi.stubEnv(name, "");
  vi.stubEnv("E2E_SUPABASE_URL", supabaseUrl);
  vi.stubEnv("HONE_LOCAL_DB_URL", dbUrl);
  return import("../../e2e/helpers/local-env");
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe("isolated-stack override", () => {
  it("neither set: the literal shared-stack defaults, unchanged", async () => {
    const env = await importWith("");
    expect(env.E2E_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(env.E2E_DB_URL).toBe("postgresql://postgres:postgres@127.0.0.1:54322/postgres");
  });

  it("both set to one loopback stack: both halves are honoured", async () => {
    const env = await importWith(ISO_API, ISO_DB);
    expect(env.E2E_SUPABASE_URL).toBe(ISO_API);
    expect(env.E2E_DB_URL).toBe(ISO_DB);
    vi.resetModules();
    expect((await importWith("http://localhost:65421", "postgresql://postgres:postgres@localhost:65422/postgres")).E2E_SUPABASE_URL).toBe(
      "http://localhost:65421",
    );
  });

  // Codex P2 4265873832: the BROWSER's app server and GoTrue's mail must follow the
  // fixtures, or setup writes one stack while the app under test reads another.
  it("neither set: the app server and Mailpit stay on the default stack", async () => {
    const env = await importWith("");
    expect(env.E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(env.E2E_MAILPIT_URL).toBe("http://127.0.0.1:54324");
  });

  it("a moved pair moves the app server and Mailpit with it, in every browser lane", async () => {
    const env = await importWith(ISO_API, ISO_DB);
    expect(env.E2E_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_URL).toBe(ISO_API);
    expect(env.E2E_MAILPIT_URL).toBe("http://127.0.0.1:63324");
    const { PAYMENT_WEB_SERVER_ENV } = await import("../../e2e-payment/helpers/payment-env");
    const { GOOGLE_WEB_SERVER_ENV } = await import("../../e2e-google/helpers/google-env");
    expect(PAYMENT_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_URL).toBe(ISO_API);
    expect(GOOGLE_WEB_SERVER_ENV.NEXT_PUBLIC_SUPABASE_URL).toBe(ISO_API);
  });

  it("the default stack spelled with localhost is still the default, not a move", async () => {
    const env = await importWith("", "postgresql://postgres:postgres@localhost:54322/postgres");
    expect(env.E2E_SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  // Half-moved pairs: a green run against the wrong database, in either direction.
  it("only the API moved: refused (fixtures would seed the shared 54322)", async () => {
    await expect(importWith(ISO_API)).rejects.toThrow(/E2E_SUPABASE_URL selects another local stack but HONE_LOCAL_DB_URL does not/);
  });

  it("only the database moved: refused (PostgREST/GoTrue would reach the shared 54321)", async () => {
    await expect(importWith("", ISO_DB)).rejects.toThrow(/HONE_LOCAL_DB_URL selects another local stack but E2E_SUPABASE_URL does not/);
  });

  it("both moved but to DIFFERENT stacks: refused (API on one, fixtures on another)", async () => {
    await expect(importWith("http://127.0.0.1:65421", ISO_DB)).rejects.toThrow(/are not one stack/);
  });

  // Honouring the values must not open a hole. Each MENTIONS loopback (or is
  // hosted) without its host BEING loopback; the old substring check admitted
  // all but the hosted one.
  it.each([
    "http://127.0.0.1.attacker.example:54321",
    "http://127.0.0.1@evil.example:54321",
    "https://x.example/?next=127.0.0.1",
    "http://localhost.evil.example",
    "https://abcd.supabase.co",
    "not a url 127.0.0.1",
  ])("an off-machine E2E_SUPABASE_URL still throws at import: %s", async (value) => {
    await expect(importWith(value, ISO_DB)).rejects.toThrow(/e2e refuses to run: E2E_SUPABASE_URL points away/);
  });

  it("an off-machine HONE_LOCAL_DB_URL still throws at import", async () => {
    await expect(importWith(ISO_API, "postgresql://u:p@127.0.0.1@db.example.com:5432/postgres")).rejects.toThrow(
      /e2e refuses to run: HONE_LOCAL_DB_URL points away/,
    );
  });
});

describe("isLoopbackUrl", () => {
  it("accepts only a loopback HOST", async () => {
    const { isLoopbackUrl } = await importWith("");
    expect(isLoopbackUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLoopbackUrl(ISO_DB)).toBe(true);
    expect(isLoopbackUrl("http://[::1]:54321")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1.nip.io")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1@evil.example")).toBe(false);
    expect(isLoopbackUrl("postgresql://u:p@db.example.com:5432/postgres?host=127.0.0.1")).toBe(false);
  });
});
