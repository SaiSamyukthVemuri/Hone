import { describe, expect, it } from "vitest";
import { ENGINE_ONLY_RPCS, rpcPrivilegeDrift } from "./rpc-privilege-drift";

// Both branches of the engine-only rule, and that it never loosens the check for any other command.
const names = ["has_studio_permission", "some_command", "other_command"];
const recorded = { has_studio_permission: "-u-D", some_command: "--sD", other_command: "-u-I" };
const base = { some_command: "--sD", other_command: "-u-I" };

describe("rpcPrivilegeDrift", () => {
  it("exempts exactly one command: the permission engine function", () => {
    expect(ENGINE_ONLY_RPCS).toEqual(["has_studio_permission"]);
  });
  it("engine installed with the recorded grants: no drift", () => {
    expect(rpcPrivilegeDrift(names, { ...base, has_studio_permission: "-u-D" }, recorded)).toEqual([]);
  });
  it("engine installed with wider grants: drift (its grants are still checked when present)", () => {
    expect(rpcPrivilegeDrift(names, { ...base, has_studio_permission: "au-D" }, recorded)).toEqual(["has_studio_permission: recorded -u-D, database au-D"]);
  });
  it("engine absent (a fresh local or CI database): the engine row is not a drift", () => {
    expect(rpcPrivilegeDrift(names, { ...base, has_studio_permission: "ABSENT" }, recorded)).toEqual([]);
  });
  it("engine absent does not excuse any other command", () => {
    expect(rpcPrivilegeDrift(names, { has_studio_permission: "ABSENT", some_command: "ABSENT", other_command: "au-I" }, recorded)).toEqual([
      "some_command: recorded --sD, database ABSENT",
      "other_command: recorded -u-I, database au-I",
    ]);
  });
  it("a command that is not engine-only is drift when absent", () => {
    expect(rpcPrivilegeDrift(["some_command"], { some_command: "ABSENT" }, { some_command: "--sD" })).toEqual(["some_command: recorded --sD, database ABSENT"]);
  });
});
