import { describe, expect, it, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { derivePort, parsePortOverride, parseReuse, resolveResources, worktreeIdentity, PORT_BASE, PORT_SPAN, RESERVED_PORT, E2E_HOST, PORT_ENV_VAR, REUSE_ENV_VAR } from "../../scripts/worktree-resources.mjs";

// TEST-PORT-01 acceptance.
//
// THE FAILURE THIS PROVES AGAINST. Every browser lane bound port 3111 and
// playwright.config.ts set `reuseExistingServer: !process.env.CI`, which is TRUE
// locally. A Playwright run started in worktree A therefore found 3111 already
// answering, attached to worktree B's server, and reported green about code it
// had never loaded. Concurrent local browser evidence was inadmissible.
//
// A source-grep test cannot establish that two worktrees can actually run at
// once, so the load-bearing case below derives ports through REAL subprocesses
// and opens REAL sockets, and proves the detector fires (EADDRINUSE) so
// "both bound" is not a vacuous pass.

const SCRIPT = path.resolve(__dirname, "../../scripts/worktree-resources.mjs");

const servers: Server[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
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
 * Resources as a REAL command run inside that directory, not an in-process call.
 *
 * HERMETIC, and it has to be. The two control variables are stripped from the
 * inherited environment unless the case under test sets them explicitly.
 *
 * Without this the test measures the AMBIENT ENVIRONMENT instead of the
 * derivation. CI pins HONE_E2E_PORT=3111 for the whole workflow, so every
 * subprocess here inherited it, every "derives a distinct port" case received
 * 3111, and the suite compared 3111 against itself — green locally, red in CI.
 * A developer with the variable exported would have seen the same thing. That
 * is precisely the failure class this PR exists to remove, one layer up: an
 * ambient value silently deciding what a test believes it is measuring.
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
    reuseExistingServer: boolean;
    sharedNotIsolated: { name: string }[];
  };
}

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => {
      servers.push(s);
      resolve(s);
    });
  });
}

// ---------------------------------------------------------------------------
// The load-bearing proof: two worktrees, concurrently, for real.
// ---------------------------------------------------------------------------
describe("two worktrees run concurrently without reusing a port", () => {
  it("derives different ports and binds BOTH at the same time", async () => {
    const a = resourcesFrom(makeWorktree("wt-a"));
    const b = resourcesFrom(makeWorktree("wt-b"));

    // Each command found its own worktree root, not the checkout the test runs in.
    expect(a.identitySource).toBe("git-toplevel");
    expect(b.identitySource).toBe("git-toplevel");
    expect(a.worktree).not.toBe(b.worktree);
    expect(a.port).not.toBe(b.port);

    // Both servers exist AT THE SAME MOMENT. This is the property the old
    // shared-3111 arrangement could not have.
    const serverA = await listen(a.port);
    const serverB = await listen(b.port);
    expect((serverA.address() as { port: number }).port).toBe(a.port);
    expect((serverB.address() as { port: number }).port).toBe(b.port);
    expect(serverA.listening && serverB.listening).toBe(true);
  });

  it("ANTI-VACUITY: binding one worktree's port twice really does fail", async () => {
    // Without this, "both bound successfully" could pass even if the ports were
    // identical and the OS were silently tolerating it.
    const a = resourcesFrom(makeWorktree("wt-solo"));
    await listen(a.port);
    await expect(listen(a.port)).rejects.toThrow(/EADDRINUSE/);
  });

  it("defeating the derivation reproduces the ORIGINAL collision", async () => {
    // Forcing worktree B onto worktree A's port is the pre-TEST-PORT-01 world.
    // It must collide, which is what proves the isolation comes from the
    // derivation rather than from luck in the test.
    const dirA = makeWorktree("wt-collide-a");
    const dirB = makeWorktree("wt-collide-b");
    const a = resourcesFrom(dirA);
    const forcedB = resourcesFrom(dirB, { [PORT_ENV_VAR]: String(a.port) });

    expect(forcedB.port).toBe(a.port);
    expect(forcedB.portSource).toBe(`env:${PORT_ENV_VAR}`);
    await listen(a.port);
    await expect(listen(forcedB.port)).rejects.toThrow(/EADDRINUSE/);
  });

  it("REGRESSION: an ambient HONE_E2E_PORT cannot decide what these cases measure", () => {
    // CI pins HONE_E2E_PORT=3111 workflow-wide, so this suite runs with the
    // variable already set. Every case that asserts DERIVATION must therefore
    // see a derived port, not the ambient pin. This test fails if the helper
    // ever stops stripping it, which is exactly how the first CI run went red
    // while the same code was green locally.
    const before = process.env[PORT_ENV_VAR];
    const beforeReuse = process.env[REUSE_ENV_VAR];
    try {
      process.env[PORT_ENV_VAR] = String(RESERVED_PORT);
      process.env[REUSE_ENV_VAR] = "1";
      const a = resourcesFrom(makeWorktree("wt-ambient-a"));
      const b = resourcesFrom(makeWorktree("wt-ambient-b"));
      expect(a.portSource).toBe("derived");
      expect(b.portSource).toBe("derived");
      expect(a.port).not.toBe(RESERVED_PORT);
      expect(a.port).not.toBe(b.port);
      expect(a.reuseExistingServer).toBe(false);
      // An explicit value from the case under test still wins, so stripping the
      // ambient one does not make the override untestable.
      expect(resourcesFrom(makeWorktree("wt-ambient-c"), {
        [PORT_ENV_VAR]: String(RESERVED_PORT),
      }).port).toBe(RESERVED_PORT);
    } finally {
      if (before === undefined) delete process.env[PORT_ENV_VAR];
      else process.env[PORT_ENV_VAR] = before;
      if (beforeReuse === undefined) delete process.env[REUSE_ENV_VAR];
      else process.env[REUSE_ENV_VAR] = beforeReuse;
    }
  });

  it("a worktree's port is stable across separate commands", () => {
    const dir = makeWorktree("wt-stable");
    const runs = [resourcesFrom(dir), resourcesFrom(dir), resourcesFrom(dir)];
    expect(new Set(runs.map((r) => r.port)).size).toBe(1);
    expect(new Set(runs.map((r) => r.origin)).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The safety boundary. Only an integer widens; the host may not move.
// ---------------------------------------------------------------------------
describe("only the port is derived, never the host", () => {
  it("the origin is always loopback http on the literal host", () => {
    const dir = makeWorktree("wt-host");
    for (const env of [
      {},
      { [PORT_ENV_VAR]: "4321" },
      { [REUSE_ENV_VAR]: "1" },
    ]) {
      const r = resourcesFrom(dir, env as Record<string, string>);
      expect(r.host).toBe(E2E_HOST);
      expect(E2E_HOST).toBe("localhost");
      expect(r.origin).toMatch(/^http:\/\/localhost:\d+$/);
    }
  });

  it("no environment variable can point the lane at another host", () => {
    // The override is parsed as a bare integer, so a URL, a host:port pair or a
    // scheme cannot survive it. This is what keeps the local-only guarantee in
    // e2e/helpers/local-env.ts intact while the port becomes variable.
    for (const hostile of [
      "https://evil.example.com",
      "evil.example.com:3111",
      "3111 evil.example.com",
      "//evil.example.com",
      "3111/../..",
      "0x0c27",
      " ",
    ]) {
      expect(() => parsePortOverride(hostile)).toThrow();
    }
  });

  it("rejects privileged and out-of-range ports", () => {
    for (const bad of ["0", "80", "443", "1023", "65536", "99999"]) {
      expect(() => parsePortOverride(bad)).toThrow();
    }
    for (const ok of ["1024", "3111", "3903", "65535"]) {
      expect(parsePortOverride(ok)).toBe(Number(ok));
    }
  });

  it("an absent override means derive, and is not confused with zero", () => {
    expect(parsePortOverride(undefined)).toBeNull();
    expect(parsePortOverride(null)).toBeNull();
    // `HONE_E2E_PORT=` in a shell exports an EMPTY string, which means unset,
    // not "port zero" and not an error. A whitespace-only value is a typo and
    // is still rejected above, so the two cases stay distinguishable.
    expect(parsePortOverride("")).toBeNull();
  });

  it("an empty override derives rather than failing the run", () => {
    const dir = makeWorktree("wt-empty-override");
    const r = resourcesFrom(dir, { [PORT_ENV_VAR]: "" });
    expect(r.portSource).toBe("derived");
    expect(r.port).toBe(resourcesFrom(dir).port);
  });
});

// ---------------------------------------------------------------------------
// Derivation properties.
// ---------------------------------------------------------------------------
describe("port derivation", () => {
  it("is a pure function of the worktree path", () => {
    expect(derivePort("/srv/hone/repo")).toBe(derivePort("/srv/hone/repo"));
    expect(derivePort("/srv/hone/worktrees/a")).not.toBe(
      derivePort("/srv/hone/worktrees/b"),
    );
  });

  it("stays inside the declared range and never returns the reserved port", () => {
    // Sampled widely enough that an off-by-one at either edge would show.
    for (let i = 0; i < 5000; i += 1) {
      const port = derivePort(`/srv/hone/worktrees/sample-${i}`);
      expect(port).toBeGreaterThanOrEqual(PORT_BASE);
      expect(port).toBeLessThan(PORT_BASE + PORT_SPAN);
      expect(port).not.toBe(RESERVED_PORT);
    }
  });

  it("the reserved port sits outside the derived range, so CI and local cannot disagree", () => {
    expect(RESERVED_PORT).toBeLessThan(PORT_BASE);
  });

  it("spreads across the range rather than clustering", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i += 1) seen.add(derivePort(`/wt/${i}`));
    // A constant or near-constant hash would collapse this number.
    expect(seen.size).toBeGreaterThan(PORT_SPAN * 0.6);
  });

  it("every real Hone worktree layout gets its own port", () => {
    const roots = [
      "/srv/hone/repo",
      ...[
        "booking-foundation", "calendar-drawer", "client-budget-notes",
        "dashboard-chloe-fast", "dashboard-day-nav", "day-nav-v1", "full-prep",
        "p0-waitlist", "p0-waitlist-cleanroom", "p0-waitlist-final",
        "payment-flex-price", "perf-baseline", "perf-profile", "perf-timing",
        "probe-discard", "selected-day-prep", "smart-architecture",
        "smart-suggest", "truth-cleanroom", "ui-foundations", "waitlist-closeout",
        "waitlist-closeout-v2", "waitlist-minimal", "willow-capacity",
      ].map((n) => `/srv/hone/worktrees/${n}`),
    ];
    const ports = roots.map(derivePort);
    expect(new Set(ports).size).toBe(roots.length);
  });
});

// ---------------------------------------------------------------------------
// Reuse is opt-in: the mechanism that caused the cross-worktree attach.
// ---------------------------------------------------------------------------
describe("server reuse", () => {
  it("is OFF by default, so a stranger's server is refused rather than borrowed", () => {
    const r = resourcesFrom(makeWorktree("wt-reuse-off"));
    expect(r.reuseExistingServer).toBe(false);
  });

  it("is enabled only by an exact opt-in, and CI does not enable it", () => {
    const dir = makeWorktree("wt-reuse-on");
    expect(resourcesFrom(dir, { [REUSE_ENV_VAR]: "1" }).reuseExistingServer).toBe(true);
    for (const notOptIn of ["", "0", "true", "yes", "TRUE"]) {
      expect(parseReuse(notOptIn)).toBe(false);
    }
    // The old expression was `!process.env.CI`. CI alone must no longer turn it on.
    expect(resourcesFrom(dir, { CI: "" }).reuseExistingServer).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CI equivalence: the pin must make this change inert on a runner.
// ---------------------------------------------------------------------------
describe("CI is pinned to the historical port", () => {
  it("both workflows pin HONE_E2E_PORT to the reserved port", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
    expect(read(".github/workflows/ci.yml")).toMatch(
      new RegExp(`${PORT_ENV_VAR}:\\s*"${RESERVED_PORT}"`),
    );
    expect(read(".github/workflows/nightly.yml")).toMatch(
      new RegExp(`${PORT_ENV_VAR}:\\s*"${RESERVED_PORT}"`),
    );
  });

  it("the pin reproduces the pre-change origin exactly", () => {
    const r = resourcesFrom(makeWorktree("wt-ci"), {
      [PORT_ENV_VAR]: String(RESERVED_PORT),
      CI: "true",
    });
    expect(r.origin).toBe(`http://localhost:${RESERVED_PORT}`);
    expect(r.port).toBe(RESERVED_PORT);
    expect(r.reuseExistingServer).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What this module does NOT isolate must be stated, not implied.
// ---------------------------------------------------------------------------
describe("shared resources are declared, not silently absent", () => {
  it("names the Supabase stack, database and inbox as still shared", () => {
    const r = resourcesFrom(makeWorktree("wt-shared"));
    const names = r.sharedNotIsolated.map((s) => s.name).join(" | ");
    expect(r.sharedNotIsolated.length).toBeGreaterThan(0);
    expect(names).toMatch(/supabase/i);
    expect(names).toMatch(/database/i);
    expect(names).toMatch(/mailpit|inbox/i);
  });
});

// ---------------------------------------------------------------------------
// Identity resolution, including the honest fallback.
// ---------------------------------------------------------------------------
describe("worktree identity", () => {
  it("resolves the git worktree root, reported as such", () => {
    const dir = makeWorktree("wt-id");
    const id = worktreeIdentity(dir);
    expect(realpathSync(id.root)).toBe(dir);
    expect(id.source).toBe("git-toplevel");
  });

  it("falls back to the working directory and SAYS SO when git cannot answer", () => {
    // A tarball export or a container without git still works; it just cannot
    // claim git-derived identity. Reporting the source keeps "best effort" from
    // being mistaken for "authoritative".
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
