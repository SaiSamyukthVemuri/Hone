import { execFileSync } from "node:child_process";

// The `browser-e2e` aggregator is several steps of one job (SHEP-LATEST-01 PR1).
// This lifts them from ci.yml and runs them the way GitHub does: in order, each in
// its OWN bash process (so no shell state can leak between steps), a step whose
// `if:` is false is skipped, and the first failing step stops the job.

export type AggStep = { name: string; ifExpr: string | null; env: string; script: string };

export function aggregatorSteps(ci: string): AggStep[] {
  const lines = ci.split("\n");
  const jobIdx = lines.findIndex((l) => l === "  browser-e2e:");
  if (jobIdx < 0) throw new Error("browser-e2e job not found in ci.yml");
  let jobEnd = lines.length;
  for (let i = jobIdx + 1; i < lines.length; i += 1) {
    if (/^ {2}[A-Za-z][\w-]*:/.test(lines[i])) { jobEnd = i; break; }
  }
  const starts: number[] = [];
  for (let i = jobIdx; i < jobEnd; i += 1) if (/^ {6}- name: /.test(lines[i])) starts.push(i);
  if (starts.length === 0) throw new Error("browser-e2e has no steps");
  return starts.map((s, k) => {
    const e = k + 1 < starts.length ? starts[k + 1] : jobEnd;
    // a step's own region ends before the next step's leading comment block
    const region = lines.slice(s, e);
    const name = region[0].replace(/^ {6}- name: /, "").trim();
    const ifLine = region.find((l) => /^ {8}if: /.test(l));
    const runIdx = region.findIndex((l) => l === "        run: |");
    if (runIdx < 0) throw new Error(`step "${name}" has no run: | block`);
    const envIdx = region.findIndex((l) => l === "        env:");
    const envText = envIdx >= 0 ? region.slice(envIdx, runIdx).join("\n") : "";
    const body: string[] = [];
    for (let i = runIdx + 1; i < region.length; i += 1) {
      const line = region[i];
      if (line.trim() === "") { body.push(""); continue; }
      const indent = line.length - line.trimStart().length;
      if (indent < 10) break;
      body.push(line.slice(10));
    }
    return { name, ifExpr: ifLine ? ifLine.replace(/^ {8}if: /, "") : null, env: envText, script: body.join("\n") };
  });
}

// Only one `if:` form exists on these steps: the draft-only step.
function stepRuns(step: AggStep, env: Record<string, string>): boolean {
  if (step.ifExpr === null) return true;
  if (step.ifExpr === "${{ github.event.pull_request.draft == true }}") return env.IS_DRAFT === "true";
  throw new Error(`unrecognised step condition: ${step.ifExpr}`);
}

export function runAggregatorSteps(steps: AggStep[], env: Record<string, string>): { code: number; out: string; ran: string[] } {
  let out = "";
  const ran: string[] = [];
  for (const step of steps) {
    if (!stepRuns(step, env)) continue;
    ran.push(step.name);
    try {
      out += execFileSync("bash", ["-c", step.script], {
        env: { ...process.env, ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const x = e as { status?: number; stdout?: string; stderr?: string };
      return { code: typeof x.status === "number" ? x.status : 1, out: `${out}${x.stdout ?? ""}${x.stderr ?? ""}`, ran };
    }
  }
  return { code: 0, out, ran };
}
