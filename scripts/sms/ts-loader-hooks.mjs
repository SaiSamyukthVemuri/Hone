// Node ESM loader hooks for the HON-50 G6 operator script ONLY.
//
// Node 20 runs neither TypeScript nor this repo's "@/" path alias, and the
// script must use the SAME evaluator the app uses (lib/sms/*.ts) rather than a
// copy. These hooks resolve extensionless relative imports and "@/" to .ts
// files under the repo, and transpile them with the repo's own `typescript`
// devDependency (types are stripped, nothing is type-checked here; `npm run
// typecheck` covers the files). No new dependency.
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function asTsFile(absolute) {
  for (const candidate of [absolute, `${absolute}.ts`, path.join(absolute, "index.ts")]) {
    if (candidate.endsWith(".ts") && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let absolute = null;
  if (specifier.startsWith("@/")) absolute = path.join(ROOT, specifier.slice(2));
  else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    absolute = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (absolute) {
    const file = asTsFile(absolute);
    if (file) return { url: pathToFileURL(file).href, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const fileName = fileURLToPath(url);
    const source = await readFile(fileName, "utf8");
    const out = ts.transpileModule(source, {
      fileName,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
