// Mutation detection for 05C: unsafe mutants wrap the real `runShepherdCli` (its arguments, its injected spawn
// and streams, or its output). A mutant is caught by a row when that row reports a violation the real
// implementation does not (the real implementation's own failures are the baseline).

/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import path from "node:path";
import {
  TOKEN,
  checkNoToken,
  checkReceiptModes,
  checkShepherd,
  checkText,
  checkTokenEcho,
  checkUsage,
  checkUsageExit,
  scenarios,
} from "./checks-shepherd";
// @ts-expect-error untyped support module
import { PROD_TIP } from "./support/worlds.mjs";
import { cleanupTmp, redirectTmpdir } from "./support/tmp";

redirectTmpdir();
afterAll(cleanupTmp);

const V2 = path.resolve(__dirname, "../../../../scripts/eng/v2");
type RunCli = (args: any) => any;

/** Buffer the real run's stdout so a mutant can rewrite the report. */
function rewriteOut(real: RunCli, f: (report: any, code: number) => { report?: any; text?: string; code?: number }): RunCli {
  return (args) => {
    let buf = "";
    const code = real({ ...args, out: { write: (c: any) => ((buf += String(c)), true) } });
    let report: any = null;
    try {
      report = JSON.parse(buf);
    } catch {
      /* text mode */
    }
    const r = report ? f(report, code) : {};
    if (r.text !== undefined) args.out.write(r.text);
    else if (r.report !== undefined) args.out.write(JSON.stringify(r.report, null, 2) + "\n");
    else args.out.write(buf);
    return r.code ?? code;
  };
}

function mutants(real: RunCli): Record<string, RunCli> {
  return {
    "C-M01 exit 0 for any decided read": (a) => {
      const c = real(a);
      return c === 4 ? 0 : c;
    },
    "C-M02 JSON mode prints a text line before the report": (a) => {
      let first = true;
      return real({ ...a, out: { write: (c: any) => (first && a.argv.includes("--json") ? ((first = false), a.out.write("shepherd: report follows\n" + c)) : a.out.write(c)) } });
    },
    "C-M03 UNKNOWN exits 4": (a) => {
      const c = real(a);
      return c === 3 ? 4 : c;
    },
    "C-M04 report omits evidenceHash": rewriteOut(real, (r) => {
      delete r.evidenceHash;
      return { report: r };
    }),
    "C-M05 humanMergeRequired false": rewriteOut(real, (r) => ({ report: { ...r, humanMergeRequired: false } })),
    "C-M06 posts a PR comment (a GitHub mutation)": (a) => {
      let posted = false;
      return real({
        ...a,
        spawn: (cmd: string, args: string[], opts: any) => {
          if (!posted) {
            posted = true;
            a.spawn("gh", ["api", "-X", "POST", "repos/SaiSamyukthVemuri/Hone/issues/800/comments", "-f", "body=shepherd was here"], opts);
          }
          return a.spawn(cmd, args, opts);
        },
      });
    },
    "C-M07 child environment inherits the parent's": (a) => real({ ...a, spawn: (cmd: string, args: string[], opts: any) => a.spawn(cmd, args, { ...opts, env: { ...a.env, ...opts.env } }) }),
    "C-M08 prints the token on stderr": (a) => {
      const c = real(a);
      if (a.env.HONE_ENG_READ_TOKEN) a.err.write(`debug: token ${a.env.HONE_ENG_READ_TOKEN}\n`);
      return c;
    },
    "C-M09 falls back to the gh session without the dedicated token": (a) => real({ ...a, env: { ...a.env, HONE_ENG_READ_TOKEN: a.env.HONE_ENG_READ_TOKEN || a.env.GH_TOKEN || "ghp_SESSIONfallback000000000000000000000" } }),
    "C-M10 a successful read is READY": rewriteOut(real, (r) => (r.evidenceHash ? { report: { ...r, decision: "CANDIDATE_READY_FOR_HUMAN_REVIEW", reasonCodes: ["CANDIDATE_READY_FOR_HUMAN_REVIEW"] }, code: 0 } : {})),
    "C-M11 production tip guessed when not established": rewriteOut(real, (r) => (r.production && r.production.tip === null ? { report: { ...r, production: { ...r.production, tip: PROD_TIP } } } : {})),
    "C-M12 diagnostics on stdout in JSON mode": (a) => real({ ...a, err: a.out }),
    "C-M13 usage error prints text in JSON mode": (a) => {
      let buf = "";
      const c = real({ ...a, out: { write: (x: any) => ((buf += String(x)), true) } });
      a.out.write(c === 2 ? "usage: npm run --silent eng -- shepherd <pr> [--json] [--no-receipt]\n" : buf);
      return c;
    },
    "C-M14 receipt reported written when disabled": rewriteOut(real, (r) => (r.receipt === "disabled" ? { report: { ...r, receipt: "written" } } : {})),
    "C-M15 token passed as a gh argument": (a) => real({ ...a, spawn: (cmd: string, args: string[], opts: any) => a.spawn(cmd, [...args, "-H", `Authorization: token ${opts?.env?.GH_TOKEN}`], opts) }),
    "C-M16 decision replaced by a stale one (memoized per PR)": (() => {
      let first: any = null;
      return rewriteOut(real, (r) => {
        if (!first && r.decision) first = { decision: r.decision, reasonCodes: r.reasonCodes };
        return first ? { report: { ...r, ...first } } : {};
      });
    })(),
  };
}

function allRows(run: RunCli, scen: any[]) {
  return [...checkShepherd(run, scen), checkText(run, scen), checkUsage(run), checkUsageExit(run), checkNoToken(run), checkTokenEcho(run), checkReceiptModes(run)];
}

const caught: Record<string, string[]> = {};
beforeAll(async () => {
  const { runShepherdCli } = await import(path.join(V2, "cli-shepherd.mjs"));
  const scen = scenarios();
  const baseRows = allRows(runShepherdCli, scen);
  const key = (r: any, v: any) => `${r.row}|${v.id}|${v.msg}`;
  const baseline = new Set(baseRows.flatMap((r: any) => r.violations.map((v: any) => key(r, v))));
  for (const [name, m] of Object.entries(mutants(runShepherdCli))) {
    caught[name] = allRows(m, scen).filter((r: any) => r.violations.some((v: any) => !baseline.has(key(r, v)))).map((r: any) => r.row);
  }
  console.log("05C mutants → catching rows:\n" + Object.entries(caught).map(([n, rs]) => `${rs.length ? "CAUGHT" : "MISSED"} ${n}: ${rs.join(", ") || "-"}`).join("\n"));
}, 900_000);

describe("05C mutants", () => {
  test("every 05C mutant is caught by at least one row", () => {
    expect(Object.entries(caught).filter(([, rs]) => rs.length === 0).map(([n]) => n)).toEqual([]);
    expect(Object.keys(caught).length).toBe(16);
  });
  const expected: [string, string][] = [
    ["C-M01 exit 0 for any decided read", "C-EXIT"],
    ["C-M02 JSON mode prints a text line before the report", "C-JSON"],
    ["C-M03 UNKNOWN exits 4", "C-EXIT"],
    ["C-M04 report omits evidenceHash", "C-FIELDS"],
    ["C-M05 humanMergeRequired false", "C-FIELDS"],
    ["C-M06 posts a PR comment (a GitHub mutation)", "C-NOMUT"],
    ["C-M07 child environment inherits the parent's", "C-ENV"],
    ["C-M08 prints the token on stderr", "C-TOKEN"],
    ["C-M09 falls back to the gh session without the dedicated token", "C-NOTOKEN"],
    ["C-M10 a successful read is READY", "C-DECISION"],
    ["C-M11 production tip guessed when not established", "C-VALUES"],
    ["C-M12 diagnostics on stdout in JSON mode", "C-RECEIPT-MODES"],
    ["C-M13 usage error prints text in JSON mode", "C-USAGE-EXIT"],
    ["C-M14 receipt reported written when disabled", "C-RECEIPT-MODES"],
    ["C-M15 token passed as a gh argument", "C-TOKEN"],
    ["C-M16 decision replaced by a stale one (memoized per PR)", "C-DECISION"],
  ];
  for (const [m, row] of expected) test(`${m} is caught by ${row}`, () => expect(caught[m]).toContain(row));
  void TOKEN;
});
