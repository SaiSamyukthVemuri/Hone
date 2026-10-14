import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// E2E_SUPABASE_URL selects an ISOLATED local stack for every PostgREST/GoTrue
// client the e2e and tests/db helpers build. Before it was honoured, those 66
// tests/db reads went to the shared 54321 stack even when HONE_LOCAL_DB_URL
// moved the pg pool elsewhere, and a split-target run wrote auth users into the
// wrong stack. Honouring it is only safe because refuseHostedOverrides() runs
// first, so the CONTROL here is that an off-machine value still throws.
//
// local-env refuses at IMPORT, and the unit lane sets NEXT_PUBLIC_SUPABASE_URL to
// a hosted-looking placeholder for the build, so every guarded name is cleared
// before each fresh import and restored afterwards.
const GUARDED = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL", "HONE_LOCAL_DB_URL", "E2E_SUPABASE_URL"];

async function importWith(supabaseUrl: string) {
  for (const name of GUARDED) vi.stubEnv(name, "");
  vi.stubEnv("E2E_SUPABASE_URL", supabaseUrl);
  return import("../../e2e/helpers/local-env");
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllEnvs());

describe("E2E_SUPABASE_URL override", () => {
  it("unset: the literal shared-stack default, unchanged", async () => {
    const env = await importWith("");
    expect(env.E2E_SUPABASE_URL).toBe("http://127.0.0.1:54321");
  });

  it("a loopback isolated stack is honoured", async () => {
    expect((await importWith("http://127.0.0.1:63321")).E2E_SUPABASE_URL).toBe("http://127.0.0.1:63321");
    vi.resetModules();
    expect((await importWith("http://localhost:65421")).E2E_SUPABASE_URL).toBe("http://localhost:65421");
  });

  // The control: honouring the value must not open a hole. Each of these MENTIONS
  // loopback (or is hosted) without its host BEING loopback; the old substring
  // check admitted the first three.
  it.each([
    "http://127.0.0.1.attacker.example:54321",
    "https://x.example/?next=127.0.0.1",
    "http://localhost.evil.example",
    "https://abcd.supabase.co",
    "not a url 127.0.0.1",
  ])("an off-machine value still throws at import: %s", async (value) => {
    await expect(importWith(value)).rejects.toThrow(/e2e refuses to run: E2E_SUPABASE_URL/);
  });
});

describe("isLoopbackUrl", () => {
  it("accepts only a loopback HOST", async () => {
    const { isLoopbackUrl } = await importWith("");
    expect(isLoopbackUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLoopbackUrl("postgresql://postgres:postgres@127.0.0.1:63322/postgres")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:54321")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1.nip.io")).toBe(false);
    expect(isLoopbackUrl("postgresql://u:p@db.example.com:5432/postgres?host=127.0.0.1")).toBe(false);
  });
});
