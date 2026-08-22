import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { derivePort, parsePortOverride, resolveResources, worktreeIdentity, PORT_BASE, PORT_SPAN, RESERVED_PORT, E2E_HOST, PORT_ENV_VAR } from "../../scripts/worktree-resources.mjs";

// ===========================================================================
// TEST-PORT-01 acceptance.
// ===========================================================================
//
// THE FAILURE CLASS. Every browser lane bound port 3111 and playwright.config.ts
// set `reuseExistingServer: !process.env.CI`, TRUE locally. A run started in
// worktree A found 3111 already answering, ATTACHED TO WORKTREE B'S SERVER, and
// reported green about code it never loaded.
//
// WHAT THIS LANE PROVES:
//   A. derivation - deterministic per worktree, integer, in range, never the
//      reserved CI port, bounded override, literal host;
//   B. an OS-owned occupied port refuses a second bind with EADDRINUSE;
//   D-equivalent, by CONFIG AUTHORITY - every Hone Playwright config sets
//      `reuseExistingServer: false` and no opt-in exists to re-enable it.
//
// WHAT THIS LANE DOES NOT PROVE. It does NOT execute Playwright, so it does not
// demonstrate a real Playwright refusal. It cannot: the validate lane
// deliberately supplies a hosted NEXT_PUBLIC_SUPABASE_URL, under which
// e2e/helpers/local-env.ts MUST refuse to load, so launching Playwright here
// would be testing against an environment designed to prevent that invocation.
// The real refusal is observed in the browser lane and in local runs, where the
// harness legitimately loads; `reuseExistingServer: false` is what Playwright
// acts on, and that is asserted here as config authority.
//
// NOT PROMISED, therefore NOT ASSERTED ANYWHERE: global uniqueness of
// candidates across arbitrary filesystem paths. A pure hash into a bounded
// range cannot provide it and does not need to, because reuse is off: a
// collision ends in refusal, not in a silent attach. The protected property is
// `occupied port -> loud failure`, never `hash -> perfect uniqueness`.

const SCRIPT = path.resolve(__dirname, "../../scripts/worktree-resources.mjs");
const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => readFileSync(path.resolve(ROOT, rel), "utf8");

const sockets: Server[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeWorktree(label: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `hone-${label}-`)));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
  return dir;
}

/**
 * Resources as a REAL command run inside that directory.
 *
 * HERMETIC: the control variable is stripped unless the case sets it. CI pins
 * HONE_E2E_PORT=3111 for the whole workflow, so without this every case would
 * observe the pin instead of the derivation.
 */
function resourcesFrom(cwd: string, env: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited[PORT_ENV_VAR];
  const out = execFileSync("node", [SCRIPT, "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...inherited, ...env },
  });
  return JSON.parse(out) as {
    worktree: string;
    identitySource: string;
    host: string;
    port: number;
    portSource: string;
    origin: string;
    reservedPort: number;
    sharedNotIsolated: { name: string; consequence: string }[];
  };
}

function cli(cwd: string, args: string[]): string {
  const inherited = { ...process.env };
  delete inherited[PORT_ENV_VAR];
  return execFileSync("node", [SCRIPT, ...args], { cwd, encoding: "utf8", env: inherited });
}

/** A port the OS says is free, held open so it is genuinely occupied by us. */
async function holdOsAssignedPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  sockets.push(server);
  return { port: (server.address() as AddressInfo).port, server };
}

function bind(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => {
      sockets.push(s);
      resolve(s);
    });
  });
}

// ===========================================================================
// A. PURE DERIVATION
// ===========================================================================
describe("A. derivation is deterministic and bounded", () => {
  it("one worktree always derives the same candidate", () => {
    const dir = makeWorktree("stable");
    const runs = [resourcesFrom(dir), resourcesFrom(dir), resourcesFrom(dir)];
    expect(new Set(runs.map((r) => r.port)).size).toBe(1);
    expect(runs[0].portSource).toBe("derived");
  });

  it("the candidate is an integer in range, and never the reserved CI port", () => {
    // Fixed inputs: fully deterministic, cannot flake.
    expect(RESERVED_PORT).toBeLessThan(PORT_BASE);
    for (let i = 0; i < 5000; i += 1) {
      const port = derivePort(`/srv/hone/worktrees/sample-${i}`);
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(PORT_BASE);
      expect(port).toBeLessThan(PORT_BASE + PORT_SPAN);
      expect(port).not.toBe(RESERVED_PORT);
    }
  });

  it("ANTI-VACUITY: derivation actually reads its input", () => {
    // Without this a constant `derivePort` would satisfy every other case in
    // Layer A. It asserts only that the function is NOT degenerate. It does NOT
    // assert uniqueness: two paths colliding is permitted behaviour.
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) seen.add(derivePort(`/wt/${i}`));
    expect(seen.size).toBeGreaterThan(1);
  });

  it("rejects overrides that are not a bare, unprivileged integer", () => {
    for (const hostile of [
      "https://evil.example.com",
      "evil.example.com:3111",
      "3111 evil.example.com",
      "//evil.example.com",
      "3111/../..",
      "0x0c27",
      " ",
      "0",
      "80",
      "1023",
      "65536",
    ]) {
      expect(() => parsePortOverride(hostile)).toThrow();
    }
  });

  it("accepts a bounded integer override; absent or empty means derive", () => {
    for (const ok of ["1024", "3111", "65535"]) {
      expect(parsePortOverride(ok)).toBe(Number(ok));
    }
    expect(parsePortOverride(undefined)).toBeNull();
    // `HONE_E2E_PORT=` in a shell exports an EMPTY string, meaning unset.
    expect(parsePortOverride("")).toBeNull();
    const dir = makeWorktree("override");
    expect(resourcesFrom(dir, { [PORT_ENV_VAR]: "4321" }).port).toBe(4321);
    expect(resourcesFrom(dir, { [PORT_ENV_VAR]: "" }).portSource).toBe("derived");
  });

  it("only the port varies; the host is a literal no variable can move", () => {
    const dir = makeWorktree("host");
    for (const env of [{}, { [PORT_ENV_VAR]: "4321" }]) {
      const r = resourcesFrom(dir, env as Record<string, string>);
      expect(r.host).toBe(E2E_HOST);
      expect(r.origin).toMatch(/^http:\/\/localhost:\d+$/);
    }
    expect(E2E_HOST).toBe("localhost");
    const src = read("scripts/worktree-resources.mjs");
    expect(src).toMatch(/export const E2E_HOST = "localhost";/);
    expect(src).not.toMatch(/E2E_HOST\s*=\s*(process\.)?env/);
    expect(src).not.toMatch(/HONE_E2E_(HOST|ORIGIN|URL|BASE_URL)/);
  });

  it("REGRESSION: an ambient HONE_E2E_PORT cannot decide what these cases measure", () => {
    const before = process.env[PORT_ENV_VAR];
    try {
      process.env[PORT_ENV_VAR] = String(RESERVED_PORT);
      const r = resourcesFrom(makeWorktree("ambient"));
      expect(r.portSource).toBe("derived");
      expect(r.port).not.toBe(RESERVED_PORT);
    } finally {
      if (before === undefined) delete process.env[PORT_ENV_VAR];
      else process.env[PORT_ENV_VAR] = before;
    }
  });

  it("resolves the git worktree root, and reports a fallback as a fallback", () => {
    const dir = makeWorktree("identity");
    const id = worktreeIdentity(dir);
    expect(realpathSync(id.root)).toBe(dir);
    expect(id.source).toBe("git-toplevel");

    const nogit = realpathSync(mkdtempSync(path.join(tmpdir(), "hone-nogit-")));
    tmpDirs.push(nogit);
    const r = resolveResources({ cwd: nogit, env: {} }) as { identitySource: string };
    expect(["cwd", "git-toplevel"]).toContain(r.identitySource);
  });

  it("the human and JSON views agree, and both declare what is NOT isolated", () => {
    // Naming the shared resources is the point: an unlisted one reads as
    // isolated. The destructive consequence must be stated, not implied.
    const dir = makeWorktree("report");
    const json = resourcesFrom(dir);
    expect(cli(dir, ["--port"]).trim()).toBe(String(json.port));
    const human = cli(dir, []);
    expect(human).toContain(json.origin);
    expect(human).toContain(json.worktree);
    const names = json.sharedNotIsolated.map((s) => s.name).join(" | ");
    expect(names).toMatch(/supabase/i);
    expect(names).toMatch(/database/i);
    expect(names).toMatch(/mailpit|inbox/i);
    expect(json.sharedNotIsolated.map((s) => s.consequence).join(" ")).toMatch(/db reset/i);
    expect(human).toMatch(/SHARED across worktrees, NOT isolated/);
  });

  it("D-EQUIVALENT CONFIG AUTHORITY: no lane may reuse a running server", () => {
    // This is a CONFIG-AUTHORITY assertion, not a behavioural one. It proves
    // what Playwright will be told, not what Playwright then does: this lane
    // cannot execute Playwright at all, because the validate job supplies a
    // hosted NEXT_PUBLIC_SUPABASE_URL under which e2e/helpers/local-env.ts must
    // refuse to load. `reuseExistingServer` is the single input Playwright acts
    // on, so pinning it false everywhere - with no opt-in able to flip it - is
    // the authority this lane can honestly carry. The real refusal is observed
    // where the harness legitimately loads.
    //
    // The retired vehicle offered HONE_E2E_REUSE_SERVER=1. It was worktree-BLIND
    // ("reuse whatever answers on this port"), so with a candidate collision it
    // recreated the silent cross-worktree attach this work exists to remove.
    // Check CODE, not prose: the module's header deliberately EXPLAINS why the
    // retired opt-in is absent, and that explanation is worth keeping.
    const stripComments = (src: string) =>
      src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
    expect(stripComments(read("scripts/worktree-resources.mjs"))).not.toMatch(
      /HONE_E2E_REUSE_SERVER/,
    );
    expect(stripComments(read("e2e/helpers/local-env.ts"))).not.toMatch(
      /HONE_E2E_REUSE_SERVER/,
    );
    // Assert on the SHAPE, not on a substring of the whole JSON: the worktree
    // path is part of that JSON, so a directory name could satisfy or break it.
    const resources = resourcesFrom(makeWorktree("shape"));
    expect(Object.keys(resources).filter((k) => /reuse/i.test(k))).toEqual([]);
    for (const cfg of [
      "playwright.config.ts",
      "playwright.mobile.config.ts",
      "playwright.payment.config.ts",
      "playwright.google.config.ts",
    ]) {
      expect(read(cfg)).toMatch(/reuseExistingServer: false/);
      expect(read(cfg)).not.toMatch(/reuseExistingServer:\s*!process\.env\.CI/);
      expect(stripComments(read(cfg))).not.toMatch(/HONE_E2E_REUSE_SERVER/);
    }
  });
});

// ===========================================================================
// B. OS-ASSIGNED SOCKET COLLISION
// ===========================================================================
describe("B. an occupied port refuses a second bind", () => {
  it("a second bind to an OCCUPIED port fails with EADDRINUSE", async () => {
    // The OS assigns the port and we keep holding it, so this never depends on
    // a derived port happening to be free on the host.
    const { port } = await holdOsAssignedPort();
    await expect(bind(port)).rejects.toThrow(/EADDRINUSE/);
  });

  it("ANTI-VACUITY: the port was genuinely ours, and frees when released", async () => {
    // If the first listen had silently failed, the rejection above would prove
    // nothing. Prove we held it, and that the same port rebinds once released.
    const { port, server } = await holdOsAssignedPort();
    expect((server.address() as AddressInfo).port).toBe(port);
    expect(server.listening).toBe(true);
    await expect(bind(port)).rejects.toThrow(/EADDRINUSE/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect((await bind(port)).listening).toBe(true);
  });
});

// ===========================================================================
// CI equivalence: the pin must make this change inert on a runner.
// ===========================================================================
describe("CI is pinned to the historical port", () => {
  it("both workflows pin HONE_E2E_PORT to the reserved port", () => {
    const pin = new RegExp(`${PORT_ENV_VAR}:\\s*"${RESERVED_PORT}"`);
    expect(read(".github/workflows/ci.yml")).toMatch(pin);
    expect(read(".github/workflows/nightly.yml")).toMatch(pin);
  });

  it("the pin reproduces the pre-change origin exactly", () => {
    const r = resourcesFrom(makeWorktree("ci"), {
      [PORT_ENV_VAR]: String(RESERVED_PORT),
      CI: "true",
    });
    expect(r.port).toBe(RESERVED_PORT);
    expect(r.origin).toBe(`http://localhost:${RESERVED_PORT}`);
  });
});
