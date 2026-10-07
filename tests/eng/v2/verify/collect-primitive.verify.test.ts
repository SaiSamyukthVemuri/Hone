/* eslint-disable @typescript-eslint/no-explicit-any -- the primitive's results and the child's recorded environment are untyped on purpose */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "node:os";

// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { TOKEN_ENV, createPrimitive } from "../../../../scripts/eng/v2/adapter/internal/github/primitive.mjs";
// prettier-ignore
// @ts-expect-error - .mjs utility ships without type declarations
import { isUnknownReason } from "../../../../scripts/eng/v2/contract/reasons.mjs";
import { DEDICATED, OPERATOR, fakeGhKit, type FakeGhKit } from "./support/fake-gh";

// ===========================================================================
// INDEPENDENT VERIFIER — SPEC-05A §5.1 "primitive.mjs" (f75ca255), black-box.
// The verifier's own fake `gh` executables (support/fake-gh.ts, one per behaviour)
// stand in for GitHub's CLI: each records its argv, its whole environment and its
// HOME's entries, then answers.
// ===========================================================================

const TOKEN_SHAPES = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/;

let kit: FakeGhKit;
const records = () => kit.records();
const clearRecords = () => kit.clear();
const PATHS: Record<string, string> = {};
beforeAll(() => {
  kit = fakeGhKit();
  PATHS.json = kit.make("json", `process.stdout.write(JSON.stringify({ hello: "world", n: [1, 2] }));`);
  PATHS.denied = kit.make(
    "denied",
    `process.stderr.write("gh: Resource not accessible by personal access token (HTTP 403)\\nsecond line: never the detail\\n"); process.exit(1);`,
  );
  PATHS.nonjson = kit.make("nonjson", `process.stdout.write("<html>not json</html>");`);
  PATHS.empty = kit.make("empty", ``);
  PATHS.slow = kit.make("slow", `setTimeout(() => process.stdout.write("{}"), 8000);`);
  PATHS.echoErr = kit.make("echo-err", `process.stderr.write("gh: Bad credentials for " + process.env.GH_TOKEN + " (HTTP 401)\\n"); process.exit(1);`);
  PATHS.shapesErr = kit.make(
    "shapes-err",
    `process.stderr.write("gh: rejected github_pat_11ABCDEFG0_${"q".repeat(59)} and ghs_${"S".repeat(36)} and ghu_${"U".repeat(36)} (HTTP 403)\\n"); process.exit(4);`,
  );
  PATHS.echoBody = kit.make("echo-body", `process.stdout.write(JSON.stringify({ body: "token " + process.env.GH_TOKEN }));`);
  PATHS.shapesBody = kit.make(
    "shapes-body",
    `process.stdout.write(JSON.stringify({ a: "ghp_${"A".repeat(36)}", b: "see github_pat_11ABCDEFG0_${"q".repeat(59)} here", c: ["gho_${"C".repeat(36)}"], d: { e: "ghs_${"S".repeat(36)}" }, ["ghr_${"R".repeat(36)}"]: 1, n: 7 }));`,
  );
});
afterAll(() => kit?.cleanup());

const envFor = (dir: string, extra: Record<string, string> = {}) => ({ [TOKEN_ENV]: DEDICATED, PATH: `${dir}:/usr/bin:/bin`, ...extra });
const REST = { label: "candidate-runs", rest: "repos/SaiSamyukthVemuri/Hone/actions/workflows/289443461/runs?head_sha=958b9d536e055e746499262cdc1a740e13501bf2&event=pull_request&per_page=100" };
const GQL = {
  label: "pr-context",
  graphql: "query($owner:String!,$name:String!,$n:Int!,$h:GitObjectID!){ repository(owner:$owner,name:$name){ pullRequest(number:$n){ number } } }",
  variables: { owner: "SaiSamyukthVemuri", name: "Hone", n: 810, h: "958b9d536e055e746499262cdc1a740e13501bf2" },
};
const open = (dir: string, extra: Record<string, string> = {}, timeoutMs = 4000) => {
  const p = createPrimitive({ env: envFor(dir, extra), timeoutMs });
  expect(p.ok, JSON.stringify(p)).toBe(true);
  return p;
};
const statsOf = (p: any): any[] => (typeof p.stats === "function" ? p.stats() : p.stats);

describe("§5.1 primitive: the dedicated read-only token, and never the operator's session", () => {
  it("the token variable is HONE_ENG_READ_TOKEN", () => {
    expect(TOKEN_ENV).toBe("HONE_ENG_READ_TOKEN");
  });

  for (const [label, given] of [
    ["no token at all", { PATH: "/usr/bin:/bin" }],
    ["an empty token", { [TOKEN_ENV]: "", PATH: "/usr/bin:/bin" }],
    ["only the operator's GH_TOKEN", { GH_TOKEN: OPERATOR, PATH: "/usr/bin:/bin" }],
    ["only GITHUB_TOKEN", { GITHUB_TOKEN: OPERATOR, PATH: "/usr/bin:/bin" }],
  ] as const) {
    it(`${label}: read_failed, and gh is never invoked`, () => {
      clearRecords();
      const env = { ...(given as Record<string, string>), PATH: `${PATHS.json}:/usr/bin:/bin` };
      const p = createPrimitive({ env, timeoutMs: 2000 });
      let r: any = p;
      if (p.ok) r = p.request(REST); // a primitive that opened anyway must still refuse
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("read_failed");
      expect(records(), "gh was invoked").toEqual([]);
    });
  }

  it("the operator's GH_TOKEN in the CALLER'S process environment is never a fallback", () => {
    clearRecords();
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = OPERATOR;
    try {
      const p = createPrimitive({ env: { PATH: `${PATHS.json}:/usr/bin:/bin` }, timeoutMs: 2000 });
      const r: any = p.ok ? p.request(REST) : p;
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("read_failed");
      expect(records()).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = saved;
    }
  });
});

describe("§5.1 primitive: a child environment built from nothing", () => {
  const CANARY_PARAM = {
    GH_TOKEN: OPERATOR,
    GITHUB_TOKEN: OPERATOR,
    GH_ENTERPRISE_TOKEN: OPERATOR,
    GH_HOST: "evil.example.com",
    GH_CONFIG_DIR: "/home/operator/.config/gh",
    HOME: "/home/operator",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    VERIFY_CANARY_PARAM: "param-canary",
    NODE_OPTIONS: "--require /tmp/evil.js",
  };
  const CANARY_VALUES = [OPERATOR, "evil.example.com", "/home/operator/.config/gh", "/home/operator", "/tmp/agent.sock", "param-canary", "process-canary", "--require /tmp/evil.js"];

  const collectChild = (extra: Record<string, string>) => {
    clearRecords();
    const saved = { a: process.env.VERIFY_CANARY_PROCESS, b: process.env.GITHUB_TOKEN };
    process.env.VERIFY_CANARY_PROCESS = "process-canary";
    process.env.GITHUB_TOKEN = OPERATOR;
    try {
      const p = open(PATHS.json, extra);
      expect(p.request(REST).ok).toBe(true);
      expect(p.request(GQL).ok).toBe(true);
      p.close?.();
    } finally {
      if (saved.a === undefined) delete process.env.VERIFY_CANARY_PROCESS;
      else process.env.VERIFY_CANARY_PROCESS = saved.a;
      if (saved.b === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = saved.b;
    }
    const rec = records();
    expect(rec.length).toBe(2);
    return rec;
  };

  it("PATH, a fresh empty HOME that is also GH_CONFIG_DIR, GH_TOKEN = the dedicated token — and nothing inherited", () => {
    for (const r of collectChild(CANARY_PARAM)) {
      const env = r.env;
      expect(env.PATH, "PATH").toBeTruthy();
      expect(env.GH_TOKEN, "GH_TOKEN is the dedicated token").toBe(DEDICATED);
      expect(env.HOME, "HOME").toBeTruthy();
      expect(env.GH_CONFIG_DIR, "GH_CONFIG_DIR is HOME").toBe(env.HOME);
      expect(env.HOME).not.toBe(os.homedir());
      expect(r.home, "HOME is a fresh EMPTY directory").toEqual([]);
      for (const k of ["GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "VERIFY_CANARY_PARAM", "VERIFY_CANARY_PROCESS", "NODE_OPTIONS"])
        expect(Object.keys(env), `${k} inherited`).not.toContain(k);
      for (const [k, v] of Object.entries(env)) {
        for (const c of CANARY_VALUES) expect(String(v), `${k} carries an inherited value`).not.toContain(c);
        if (k !== "GH_TOKEN") expect(String(v), `${k} carries the token`).not.toContain(DEDICATED);
      }
    }
  });

  it("the remaining settings are FIXED: the same whatever the caller's environment holds", () => {
    const strip = (e: any) => Object.fromEntries(Object.entries(e).filter(([k]) => !["PATH", "HOME", "GH_CONFIG_DIR", "GH_TOKEN"].includes(k)));
    const a = strip(collectChild({})[0].env);
    const b = strip(collectChild(CANARY_PARAM)[0].env);
    expect(b).toEqual(a);
  });
});

describe("§5.1 primitive: the request it sends", () => {
  it("REST is GET with fixed Accept and API-version headers; the route is the endpoint; no body fields; no token in argv", () => {
    clearRecords();
    const p = open(PATHS.json);
    p.request(REST);
    p.request({ label: "compare", rest: "repos/SaiSamyukthVemuri/Hone/compare/a...b" });
    const [a, b] = records().map((r) => r.argv as string[]);
    for (const argv of [a, b]) {
      expect(argv[0]).toBe("api");
      const j = argv.join(" ");
      expect(/(--method[ =]GET|-X ?GET)\b/.test(j), `method GET: ${j}`).toBe(true);
      expect(/(--method[ =]|-X ?)(?!GET\b)\w+/.test(j.replace(/(--method[ =]GET|-X ?GET)\b/g, "")), `a second method: ${j}`).toBe(false);
      expect(argv.some((x, i) => (argv[i - 1] === "-H" || argv[i - 1] === "--header") && /^accept:/i.test(x)), `Accept header: ${j}`).toBe(true);
      expect(argv.some((x, i) => (argv[i - 1] === "-H" || argv[i - 1] === "--header") && /^x-github-api-version:/i.test(x)), `API version: ${j}`).toBe(true);
      for (const f of ["-f", "-F", "--field", "--raw-field", "--input"]) expect(argv, `${f} would send a body`).not.toContain(f);
      expect(j).not.toContain(DEDICATED);
    }
    expect(a[a.length - 1]).toBe(REST.rest);
    // fixed: the same headers for every request
    const headers = (argv: string[]) => argv.filter((_, i) => argv[i - 1] === "-H" || argv[i - 1] === "--header");
    expect(headers(b)).toEqual(headers(a));
  });

  it("GraphQL: the document with -f, strings with -f, numbers with -F — a string never with -F (no @file reads, no type coercion)", () => {
    clearRecords();
    const p = open(PATHS.json);
    p.request(GQL);
    p.request({ label: "odd", graphql: GQL.graphql, variables: { owner: "@/etc/passwd", name: "true", h: "1234567890123456789012345678901234567890", n: 7 } });
    const [a, b] = records().map((r) => r.argv as string[]);
    const pairs = (argv: string[]) => {
      const out: Record<string, string> = {};
      argv.forEach((x, i) => {
        if (argv[i - 1] === "-f" || argv[i - 1] === "--raw-field" || argv[i - 1] === "-F" || argv[i - 1] === "--field") {
          const k = x.slice(0, x.indexOf("="));
          out[k] = argv[i - 1] === "-f" || argv[i - 1] === "--raw-field" ? "-f" : "-F";
        }
      });
      return out;
    };
    expect(a.slice(0, 2)).toEqual(["api", "graphql"]);
    expect(a).toContain(`query=${GQL.graphql}`);
    expect(pairs(a)).toEqual({ query: "-f", owner: "-f", name: "-f", h: "-f", n: "-F" });
    expect(pairs(b)).toEqual({ query: "-f", owner: "-f", name: "-f", h: "-f", n: "-F" });
    expect(b).toContain("owner=@/etc/passwd");
    expect(a.join(" ") + b.join(" ")).not.toContain(DEDICATED);
  });
});

describe("§5.1 primitive: answers", () => {
  it("exit 0 with JSON is the body", () => {
    const r = open(PATHS.json).request(REST);
    expect(r).toEqual({ ok: true, body: { hello: "world", n: [1, 2] } });
  });

  it("a non-zero exit is read_failed: the reader's label and gh's FIRST stderr line", () => {
    const r = open(PATHS.denied).request(REST);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("read_failed");
    expect(r.detail).toContain("candidate-runs");
    expect(r.detail).toContain("gh: Resource not accessible by personal access token (HTTP 403)");
    expect(r.detail).not.toContain("second line");
    expect(r.detail.indexOf("candidate-runs")).toBeLessThan(r.detail.indexOf("gh: Resource"));
  });

  for (const [what, dir] of [
    ["non-JSON output", "nonjson"],
    ["empty output", "empty"],
  ] as const)
    it(`${what} is malformed`, () => {
      const r = open(PATHS[dir]).request(REST);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed");
      expect(isUnknownReason(r.reason)).toBe(true);
    });

  it("a timeout is read_failed, and comes back near the limit", () => {
    const p = open(PATHS.slow, {}, 500);
    const t0 = Date.now();
    const r = p.request(REST);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("read_failed");
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("§5.1 primitive: the token is never an argument, a result, a detail or a statistic", () => {
  it("an echo of the token in gh's stderr is redacted from the detail", () => {
    const r = open(PATHS.echoErr).request(REST);
    expect(r.reason).toBe("read_failed");
    expect(r.detail).not.toContain(DEDICATED);
    expect(TOKEN_SHAPES.test(r.detail), r.detail).toBe(false);
  });

  it("a non-standard token value echoed in stderr is redacted too (the value, not just its shape)", () => {
    const odd = "s3cr3t-dedicated-value-xyz";
    const p = createPrimitive({ env: { [TOKEN_ENV]: odd, PATH: `${PATHS.echoErr}:/usr/bin:/bin` }, timeoutMs: 4000 });
    const r = p.request(REST);
    expect(r.detail).not.toContain(odd);
  });

  it("anything shaped like a GitHub token in stderr is redacted from the detail", () => {
    const r = open(PATHS.shapesErr).request(REST);
    expect(r.reason).toBe("read_failed");
    expect(TOKEN_SHAPES.test(r.detail), r.detail).toBe(false);
  });

  it("the token echoed in a successful answer is not returned in the result (§5.1 'never … a result')", () => {
    const r = open(PATHS.echoBody).request(REST);
    expect(JSON.stringify(r)).not.toContain(DEDICATED);
  });

  it("anything shaped like a GitHub token is redacted from a successful body, before it is parsed (63bd3b6e)", () => {
    const r = open(PATHS.shapesBody).request(REST);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const text = JSON.stringify(r);
    expect(TOKEN_SHAPES.test(text), text).toBe(false);
    expect(r.body.n).toBe(7);
    expect(Object.keys(r.body).length).toBe(6);
  });

  it("every request is counted and timed as exactly { label, ms, ok } — never a body", () => {
    const p = open(PATHS.json);
    p.request(REST);
    p.request(GQL);
    const q = open(PATHS.denied);
    q.request(REST);
    const s = statsOf(p);
    expect(s.length).toBe(2);
    for (const e of [...s, ...statsOf(q)]) {
      expect(Object.keys(e).sort()).toEqual(["label", "ms", "ok"]);
      expect(typeof e.ms === "number" && e.ms >= 0).toBe(true);
      expect(JSON.stringify(e)).not.toContain("hello");
    }
    expect(s.map((e: any) => [e.label, e.ok])).toEqual([
      ["candidate-runs", true],
      ["pr-context", true],
    ]);
    expect(statsOf(q).map((e: any) => [e.label, e.ok])).toEqual([["candidate-runs", false]]);
  });

  it("a statistic never carries the token, even when a label does", () => {
    const p = open(PATHS.json);
    p.request({ ...REST, label: `candidate-runs ${DEDICATED}` });
    for (const e of statsOf(p)) expect(JSON.stringify(e)).not.toContain(DEDICATED);
  });
});

describe("§5.1 primitive: requests outside the two shapes (amended 63bd3b6e)", () => {
  // "A request must be exactly one of the two shapes — { label, rest } or { label, graphql, variables }, with string
  // or integer variables — or it is refused as malformed before anything is spawned."
  const G = "query($n:Int!){ repository(owner:\"o\",name:\"n\"){ pullRequest(number:$n){ number } } }";
  const REFUSED: Array<[string, unknown]> = [
    ["neither shape", { label: "neither" }],
    ["both shapes", { label: "both", rest: "repos/x", graphql: G, variables: { n: 1 } }],
    ["no label", { rest: "repos/x" }],
    ["an empty label", { label: "", rest: "repos/x" }],
    ["a label that is not a string", { label: 5, rest: "repos/x" }],
    ["a route that is not a string", { label: "x", rest: 5 }],
    ["a document that is not a string", { label: "x", graphql: 5, variables: {} }],
    ["variables that are an array", { label: "x", graphql: G, variables: [] }],
    ["a fractional variable", { label: "x", graphql: G, variables: { n: 1.5 } }],
    ["an unsafe integer variable", { label: "x", graphql: G, variables: { n: 2 ** 60 } }],
    ["a boolean variable", { label: "x", graphql: G, variables: { b: true } }],
    ["a null variable", { label: "x", graphql: G, variables: { z: null } }],
    ["an object variable", { label: "x", graphql: G, variables: { o: { a: 1 } } }],
    ["an array variable", { label: "x", graphql: G, variables: { a: ["x"] } }],
    ["null", null],
    ["undefined", undefined],
    ["a bare route string", "repos/x"],
  ];
  for (const [label, req] of REFUSED)
    it(`${label}: malformed, refused before anything is spawned, and nothing throws`, () => {
      clearRecords();
      const p = open(PATHS.json);
      let r: any;
      expect(() => (r = p.request(req))).not.toThrow();
      expect(r?.ok, JSON.stringify(req)).toBe(false);
      expect(r?.reason).toBe("malformed");
      expect(records(), "gh was spawned").toEqual([]);
    });

  it("the two shapes, with string and integer variables, are sent", () => {
    clearRecords();
    const p = open(PATHS.json);
    expect(p.request({ label: "rest", rest: "repos/x" }).ok).toBe(true);
    expect(p.request({ label: "gql", graphql: G, variables: { n: 810, s: "a", neg: -3 } }).ok).toBe(true);
    expect(records().length).toBe(2);
  });

  // NEW FINDINGS (pass 4, low; unreachable through the readers, which never add a key or omit variables). Strict
  // known-failures: each fails, and must be re-derived, once 63bd3b6e's behaviour is brought to "exactly".
  it.fails("[known deviation at 63bd3b6e] a REST request with an extra key is not exactly { label, rest }: refused before spawning", () => {
    clearRecords();
    const r = open(PATHS.json).request({ label: "x", rest: "repos/x", method: "POST" });
    expect(r.ok).toBe(false);
    expect(records()).toEqual([]);
  });
  it.fails("[known deviation at 63bd3b6e] a GraphQL request without variables is not { label, graphql, variables }: refused before spawning", () => {
    clearRecords();
    const r = open(PATHS.json).request({ label: "x", graphql: G });
    expect(r.ok).toBe(false);
    expect(records()).toEqual([]);
  });
});
