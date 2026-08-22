import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type AddressInfo, type Server } from "node:net";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { derivePort, parsePortOverride, parseReuse, resolveResources, worktreeIdentity, PORT_BASE, PORT_SPAN, RESERVED_PORT, E2E_HOST, PORT_ENV_VAR, REUSE_ENV_VAR } from "../../scripts/worktree-resources.mjs";

// ===========================================================================
// TEST-PORT-01 acceptance, rebuilt around the ACTUAL runtime contract.
// ===========================================================================
//
// THE FAILURE CLASS. Every browser lane bound port 3111 and both
// playwright.config.ts and playwright.mobile.config.ts set
// `reuseExistingServer: !process.env.CI`, which is TRUE locally. A run started
// in worktree A found 3111 already answering, ATTACHED TO WORKTREE B'S SERVER,
// and reported green about code it never loaded.
//
// THE CONTRACT THIS SUITE PROVES, and deliberately no more:
//   1. one worktree deterministically derives the same CANDIDATE port;
//   2. the candidate stays in the derived range and is never the reserved CI
//      port 3111;
//   3. an explicit override is a bounded integer and the host stays literal;
//   4. server reuse is opt-in;
//   5. if two worktrees ever select the same candidate, the second bind fails
//      LOUDLY;
//   6. a collision never lets Playwright attach to the other worktree's server.
//
// WHAT IS NOT PROMISED, and therefore NOT ASSERTED ANYWHERE HERE: global
// uniqueness of candidates across arbitrary filesystem paths. A pure hash into
// a bounded range cannot provide it, and the runtime deliberately does not try.
// An earlier version of this file asserted uniqueness in three places, which is
// a stronger contract than the implementation provides; those assertions were
// nondeterministically red for a correct implementation and are retired.
//
// The protected property is `collision -> loud failure`, NOT
// `hash -> perfect global uniqueness`. Layer B therefore binds OS-ASSIGNED
// ports rather than derived ones: it must not assume a derived port happens to
// be free on the developer's machine.

const SCRIPT = path.resolve(__dirname, "../../scripts/worktree-resources.mjs");
const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

const sockets: (Server | HttpServer)[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const s of sockets.splice(0)) s.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throwaway directory that is its own git repository, i.e. its own worktree root. */
function makeWorktree(label: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `hone-${label}-`)));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "--quiet"], { cwd: dir, stdio: "ignore" });
  return dir;
}

/**
 * Resources as a REAL command run inside that directory.
 *
 * HERMETIC. The two control variables are stripped from the inherited
 * environment unless the case under test sets them explicitly. CI pins
 * HONE_E2E_PORT=3111 for the whole workflow, so without this every case would
 * observe the pin instead of the derivation.
 */
function resourcesFrom(cwd: string, env: Record<string, string> = {}) {
  const inherited = { ...process.env };
  delete inherited[PORT_ENV_VAR];
  delete inherited[REUSE_ENV_VAR];
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
    derivedRange: [number, number];
    reuseExistingServer: boolean;
    reuseSource: string;
    sharedNotIsolated: { name: string; detail: string; consequence: string }[];
  };
}

function cli(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const inherited = { ...process.env };
  delete inherited[PORT_ENV_VAR];
  delete inherited[REUSE_ENV_VAR];
  return execFileSync("node", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...inherited, ...env },
  });
}

/**
 * Reserve a port the OS says is free, and KEEP HOLDING IT. Layer B needs a port
 * that is genuinely occupied by a known owner; asking the OS for one is the
 * only way to get that without assuming anything about the host's free ports.
 */
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
// LAYER A - PURE DERIVATION
// No sockets, no host assumptions, and no cross-input uniqueness assertions.
// ===========================================================================
describe("A. derivation is deterministic and bounded", () => {
  it("one worktree always derives the same candidate", () => {
    const dir = makeWorktree("wt-stable");
    const runs = [resourcesFrom(dir), resourcesFrom(dir), resourcesFrom(dir)];
    expect(new Set(runs.map((r) => r.port)).size).toBe(1);
    expect(new Set(runs.map((r) => r.origin)).size).toBe(1);
    expect(runs[0].portSource).toBe("derived");
  });

  it("the same path derives the same candidate as a pure function", () => {
    expect(derivePort("/srv/hone/repo")).toBe(derivePort("/srv/hone/repo"));
    expect(derivePort("/a/b/c")).toBe(derivePort("/a/b/c"));
  });

  it("the candidate is an integer inside the declared range", () => {
    // Fixed inputs, so this is fully deterministic: it cannot flake.
    for (let i = 0; i < 5000; i += 1) {
      const port = derivePort(`/srv/hone/worktrees/sample-${i}`);
      expect(Number.isInteger(port)).toBe(true);
      expect(port).toBeGreaterThanOrEqual(PORT_BASE);
      expect(port).toBeLessThan(PORT_BASE + PORT_SPAN);
    }
  });

  it("the reserved CI port is never derived", () => {
    expect(RESERVED_PORT).toBeLessThan(PORT_BASE);
    for (let i = 0; i < 5000; i += 1) {
      expect(derivePort(`/srv/hone/worktrees/sample-${i}`)).not.toBe(RESERVED_PORT);
    }
  });

  it("ANTI-VACUITY: derivation actually reads its input", () => {
    // Without this, a constant `derivePort` would satisfy every other case in
    // Layer A. It asserts only that the function is NOT degenerate - more than
    // one distinct candidate across a fixed sample. It does NOT assert
    // uniqueness: two paths colliding is permitted behaviour.
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
      "443",
      "1023",
      "65536",
      "99999",
    ]) {
      expect(() => parsePortOverride(hostile)).toThrow();
    }
  });

  it("accepts a valid integer override", () => {
    for (const ok of ["1024", "3111", "3903", "65535"]) {
      expect(parsePortOverride(ok)).toBe(Number(ok));
    }
    const dir = makeWorktree("wt-override");
    const r = resourcesFrom(dir, { [PORT_ENV_VAR]: "4321" });
    expect(r.port).toBe(4321);
    expect(r.portSource).toBe(`env:${PORT_ENV_VAR}`);
    expect(r.origin).toBe("http://localhost:4321");
  });

  it("an absent or empty override derives instead of failing", () => {
    expect(parsePortOverride(undefined)).toBeNull();
    expect(parsePortOverride(null)).toBeNull();
    // `HONE_E2E_PORT=` in a shell exports an EMPTY string, meaning unset.
    expect(parsePortOverride("")).toBeNull();
    const dir = makeWorktree("wt-empty");
    expect(resourcesFrom(dir, { [PORT_ENV_VAR]: "" }).portSource).toBe("derived");
  });

  it("only the port varies; the host is a literal no variable can move", () => {
    const dir = makeWorktree("wt-host");
    for (const env of [{}, { [PORT_ENV_VAR]: "4321" }, { [REUSE_ENV_VAR]: "1" }]) {
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
    // CI pins HONE_E2E_PORT=3111 workflow-wide, so this suite runs with the
    // variable already set. Cases that assert DERIVATION must observe a derived
    // candidate, not the ambient pin.
    const before = process.env[PORT_ENV_VAR];
    const beforeReuse = process.env[REUSE_ENV_VAR];
    try {
      process.env[PORT_ENV_VAR] = String(RESERVED_PORT);
      process.env[REUSE_ENV_VAR] = "1";
      const r = resourcesFrom(makeWorktree("wt-ambient"));
      expect(r.portSource).toBe("derived");
      expect(r.port).not.toBe(RESERVED_PORT);
      expect(r.reuseExistingServer).toBe(false);
      // An explicit value from the case under test still wins.
      expect(
        resourcesFrom(makeWorktree("wt-ambient-explicit"), {
          [PORT_ENV_VAR]: String(RESERVED_PORT),
        }).port,
      ).toBe(RESERVED_PORT);
    } finally {
      if (before === undefined) delete process.env[PORT_ENV_VAR];
      else process.env[PORT_ENV_VAR] = before;
      if (beforeReuse === undefined) delete process.env[REUSE_ENV_VAR];
      else process.env[REUSE_ENV_VAR] = beforeReuse;
    }
  });
});

describe("A. identity resolution", () => {
  it("resolves the git worktree root and reports the source", () => {
    const dir = makeWorktree("wt-id");
    const id = worktreeIdentity(dir);
    expect(realpathSync(id.root)).toBe(dir);
    expect(id.source).toBe("git-toplevel");
  });

  it("falls back to the working directory and SAYS SO when git cannot answer", () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "hone-nogit-")));
    tmpDirs.push(dir);
    const r = resolveResources({ cwd: dir, env: {} }) as {
      identitySource: string;
      port: number;
    };
    expect(["cwd", "git-toplevel"]).toContain(r.identitySource);
    expect(r.port).toBeGreaterThanOrEqual(PORT_BASE);
  });
});

describe("A. resource reporting", () => {
  it("the human and JSON views agree", () => {
    const dir = makeWorktree("wt-report");
    const json = resourcesFrom(dir);
    const human = cli(dir, []);
    const bare = cli(dir, ["--port"]).trim();
    expect(bare).toBe(String(json.port));
    expect(human).toContain(json.origin);
    expect(human).toContain(json.worktree);
    expect(human).toContain(String(json.reservedPort));
  });

  it("declares the resources it does NOT isolate, in both views", () => {
    // Naming them is the point: an unlisted shared resource reads as isolated.
    const dir = makeWorktree("wt-shared");
    const json = resourcesFrom(dir);
    const names = json.sharedNotIsolated.map((s) => s.name).join(" | ");
    expect(json.sharedNotIsolated.length).toBeGreaterThan(0);
    expect(names).toMatch(/supabase/i);
    expect(names).toMatch(/database/i);
    expect(names).toMatch(/mailpit|inbox/i);
    // The destructive consequence must be stated, not merely implied.
    expect(json.sharedNotIsolated.map((s) => s.consequence).join(" ")).toMatch(/db reset/i);
    const human = cli(dir, []);
    expect(human).toMatch(/SHARED across worktrees, NOT isolated/);
    expect(human).toMatch(/supabase/i);
  });
});

// ===========================================================================
// LAYER B - CONTROLLED REAL SOCKET COLLISION
// The property that matters, proved on a port the OS confirms is ours.
// ===========================================================================
describe("B. a port collision fails loudly", () => {
  it("a second bind to an OCCUPIED port is refused with EADDRINUSE", async () => {
    // The OS assigns the port and we keep holding it, so this never depends on
    // a derived port happening to be free on the developer's machine.
    const { port } = await holdOsAssignedPort();
    await expect(bind(port)).rejects.toThrow(/EADDRINUSE/);
  });

  it("the held port is genuinely ours, and frees cleanly when released", async () => {
    // ANTI-VACUITY for the case above: if the first listen had silently failed,
    // the rejection would prove nothing. Prove the port was occupied by us, and
    // that the same port becomes bindable once we let it go.
    const { port, server } = await holdOsAssignedPort();
    expect((server.address() as AddressInfo).port).toBe(port);
    expect(server.listening).toBe(true);
    await expect(bind(port)).rejects.toThrow(/EADDRINUSE/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const reopened = await bind(port);
    expect(reopened.listening).toBe(true);
  });
});

describe("B. server reuse is opt-in", () => {
  it("is OFF by default, so a stranger's server is refused rather than borrowed", () => {
    expect(resourcesFrom(makeWorktree("wt-reuse-off")).reuseExistingServer).toBe(false);
  });

  it("is enabled only by the exact Hone opt-in, and CI alone does not enable it", () => {
    const dir = makeWorktree("wt-reuse-on");
    expect(resourcesFrom(dir, { [REUSE_ENV_VAR]: "1" }).reuseExistingServer).toBe(true);
    for (const notOptIn of ["", "0", "true", "yes", "TRUE"]) {
      expect(parseReuse(notOptIn)).toBe(false);
    }
    // The old expression was `!process.env.CI`. CI must no longer decide this.
    expect(resourcesFrom(dir, { CI: "" }).reuseExistingServer).toBe(false);
    expect(resourcesFrom(dir, { CI: "true" }).reuseExistingServer).toBe(false);
  });

  it("both Playwright configs take reuse from the opt-in, not from CI", () => {
    for (const cfg of ["playwright.config.ts", "playwright.mobile.config.ts"]) {
      const src = read(cfg);
      expect(src).not.toMatch(/reuseExistingServer:\s*!process\.env\.CI/);
      expect(src).toMatch(/reuseExistingServer: E2E_REUSE_EXISTING_SERVER/);
    }
    // The two fake-provider lanes were already fail-closed; keep them that way.
    expect(read("playwright.payment.config.ts")).toMatch(/reuseExistingServer: false/);
    expect(read("playwright.google.config.ts")).toMatch(/reuseExistingServer: false/);
  });
});

// ===========================================================================
// LAYER C - FORCED SAME-PORT COLLISION CANNOT SILENTLY REUSE
// The negative integration proof, on a real server, with a real collision.
// ===========================================================================
describe("C. a forced same-port second worktree cannot reuse the first server", () => {
  it("the second worktree can neither start its own server nor be allowed to borrow", async () => {
    // Worktree A: a REAL server, on a port the OS assigned, answering.
    const first = createHttpServer((_req, res) => res.end("worktree-A"));
    await new Promise<void>((resolve, reject) => {
      first.once("error", reject);
      first.listen(0, "127.0.0.1", () => resolve());
    });
    sockets.push(first);
    const occupied = (first.address() as AddressInfo).port;

    // Worktree B: deliberately forced onto worktree A's exact port.
    const forced = resourcesFrom(makeWorktree("wt-forced"), {
      [PORT_ENV_VAR]: String(occupied),
    });
    expect(forced.port).toBe(occupied);

    // 1. B cannot start its own server there: the bind is refused.
    await expect(bind(occupied)).rejects.toThrow(/EADDRINUSE/);

    // 2. B is not permitted to attach to whatever is already answering, so
    //    Playwright refuses instead of adopting worktree A's server. That
    //    combination is what makes a collision loud rather than silently green.
    expect(forced.reuseExistingServer).toBe(false);
    expect(read("playwright.config.ts")).toMatch(
      /reuseExistingServer: E2E_REUSE_EXISTING_SERVER/,
    );
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
    const r = resourcesFrom(makeWorktree("wt-ci"), {
      [PORT_ENV_VAR]: String(RESERVED_PORT),
      CI: "true",
    });
    expect(r.port).toBe(RESERVED_PORT);
    expect(r.origin).toBe(`http://localhost:${RESERVED_PORT}`);
    expect(r.reuseExistingServer).toBe(false);
  });
});
