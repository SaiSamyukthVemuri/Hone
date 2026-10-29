import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// HELD (Sam, 2026-10-28): client identification portrait use is OFF until an
// explicit enabling input exists. Behavioural proof of the policy and of the
// action gate, source proof of the render gates, and a guard that no caller
// bypasses the policy.

const rpc = vi.fn();
const createClient = vi.fn(async () => ({ rpc }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({ studio: { id: "studio-1" } })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn() }));

import { clientPortraitEnabled } from "@/lib/images/portrait-policy";
import { setClientPortraitAction } from "@/app/(app)/clients/[id]/images/actions";

const ROOT = process.cwd();
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

beforeEach(() => {
  rpc.mockReset();
  createClient.mockClear();
  rpc.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());

describe("clientPortraitEnabled fails closed", () => {
  it("is OFF when the variable is absent", () => {
    vi.stubEnv("HONE_CLIENT_PORTRAIT_ENABLED", undefined as unknown as string);
    delete process.env.HONE_CLIENT_PORTRAIT_ENABLED;
    expect(clientPortraitEnabled()).toBe(false);
  });

  it.each(["", "TRUE", "True", "1", "yes", "on", " true", "true ", "false"])("is OFF for %j", (v) => {
    vi.stubEnv("HONE_CLIENT_PORTRAIT_ENABLED", v);
    expect(clientPortraitEnabled()).toBe(false);
  });

  it("is ON only for the exact string true", () => {
    vi.stubEnv("HONE_CLIENT_PORTRAIT_ENABLED", "true");
    expect(clientPortraitEnabled()).toBe(true);
  });
});

describe("setClientPortraitAction gate", () => {
  it("OFF: refuses with a fixed sentence and never builds a client or calls the RPC", async () => {
    delete process.env.HONE_CLIENT_PORTRAIT_ENABLED;
    for (const imageId of ["img-1", null]) {
      const res = await setClientPortraitAction({ clientId: "c-1", imageId });
      expect(res).toEqual({ ok: false, error: "ID photos are not available." });
    }
    expect(createClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("ON: calls set_client_portrait as before", async () => {
    vi.stubEnv("HONE_CLIENT_PORTRAIT_ENABLED", "true");
    const res = await setClientPortraitAction({ clientId: "c-1", imageId: "img-1", expectedImageId: null });
    expect(res).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("set_client_portrait", {
      p_client_id: "c-1",
      p_image_id: "img-1",
      p_expected_image_id: null,
    });
  });
});

describe("render gates", () => {
  const header = read("app/(app)/clients/[id]/page.tsx");
  const imagesPage = read("app/(app)/clients/[id]/images/page.tsx");
  const manager = read("app/(app)/clients/[id]/images/TreatmentImagesManager.tsx");

  it("header: signs nothing and renders no portrait when OFF", () => {
    expect(header).toMatch(/clientPortraitEnabled\(\)\s*\?\s*signedClientPortraitUrl\(/);
    expect(header).toMatch(/:\s*Promise\.resolve\(null\)/);
  });

  it("images tab: passes no portrait id and renders no control when OFF", () => {
    expect(imagesPage).toMatch(/const portraitEnabled = clientPortraitEnabled\(\);/);
    expect(imagesPage).toMatch(/portraitImageId=\{portraitEnabled \? \(client\.portrait_image_id \?\? null\) : null\}/);
    expect(imagesPage).toMatch(/portraitEnabled=\{portraitEnabled\}/);
    // Fail closed: the manager defaults to OFF if a caller forgets the prop.
    expect(manager).toMatch(/portraitEnabled = false,/);
    expect(manager).toMatch(/\{portraitEnabled && <PortraitControl /);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir))) {
    if (e === "node_modules" || e === ".next") continue;
    const rel = `${dir}/${e}`;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(rel);
  }
  return out;
}

describe("source guard: every portrait caller goes through the policy", () => {
  const files = ["app", "lib", "components"].flatMap((d) => walk(d));
  const callers = (needle: RegExp, definedIn: string[]) =>
    files.filter((f) => !definedIn.includes(f) && needle.test(read(f)));

  it("every file that calls set_client_portrait or signedClientPortraitUrl imports clientPortraitEnabled and calls it before", () => {
    const rpcFiles = files.filter((f) => /rpc\(\s*"set_client_portrait"/.test(read(f)));
    const signFiles = callers(/signedClientPortraitUrl\s*\(/, ["lib/images/client-portrait.ts"]);
    expect(rpcFiles).toEqual(["app/(app)/clients/[id]/images/actions.ts"]);
    expect(signFiles).toEqual(["app/(app)/clients/[id]/page.tsx"]);
    for (const f of [...rpcFiles, ...signFiles]) {
      const src = read(f);
      expect(src, f).toContain('from "@/lib/images/portrait-policy"');
      const gate = src.indexOf("clientPortraitEnabled()");
      const use = Math.min(...[src.indexOf('rpc("set_client_portrait"'), src.indexOf("signedClientPortraitUrl(")].filter((i) => i >= 0));
      expect(gate, f).toBeGreaterThan(-1);
      expect(gate, f).toBeLessThan(use);
    }
  });

  it("PortraitControl is rendered only behind the portraitEnabled prop", () => {
    const users = callers(/<PortraitControl\b/, ["app/(app)/clients/[id]/images/PortraitControl.tsx"]);
    expect(users).toEqual(["app/(app)/clients/[id]/images/TreatmentImagesManager.tsx"]);
    expect(read(users[0])).toMatch(/\{portraitEnabled && <PortraitControl\b/);
  });

  it("the policy is server-only and reads exactly one exact-match variable", () => {
    const src = read("lib/images/portrait-policy.ts");
    expect(src).toContain('import "server-only";');
    expect(src).toMatch(/process\.env\.HONE_CLIENT_PORTRAIT_ENABLED === "true"/);
    expect(src.match(/process\.env/g)).toHaveLength(1);
  });
});
