// LOCAL-ONLY synthetic Fett twin tooling (#825). Runs ONLY tests/twin/*.twin.ts, one file at a time, and
// only through scripts/fett-twin/reset.sh, which pins the isolated target. Neither the unit config
// (tests/**/*.test.ts) nor the DB config (tests/db/**/*.db.test.ts) can pick these files up.
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.db.config";

const merged = mergeConfig(base, defineConfig({}));
merged.test = { ...merged.test, include: ["tests/twin/*.twin.ts"], fileParallelism: false };
export default merged;
