import { describe, expect, it, vi } from "vitest";
import {
  DEADLOCK_SQLSTATE,
  MAX_DEADLOCK_RETRIES,
  TRY_AGAIN_MESSAGE,
  isDeadlock,
  retryOnDeadlock,
  retryThrownDeadlock,
  userMessageForDeadlock,
} from "@/lib/subscriptions/deadlock-retry";

const noSleep = async () => {};
const dead = { code: "40P01", message: "deadlock detected" };

describe("isDeadlock", () => {
  it("is true only for SQLSTATE 40P01", () => {
    expect(DEADLOCK_SQLSTATE).toBe("40P01");
    expect(isDeadlock(dead)).toBe(true);
    for (const e of [
      { code: "40001" }, // serialization failure
      { code: "55P03" }, // lock timeout
      { code: "P0001" }, // practitioner_limit_reached
      { code: "23505" },
      { code: 40 },
      { message: "deadlock detected" }, // message text is never trusted
      "40P01",
      null,
      undefined,
    ]) {
      expect(isDeadlock(e), JSON.stringify(e)).toBe(false);
    }
  });
});

describe("retryOnDeadlock (resolved { error })", () => {
  it("passes a first success through without retrying", async () => {
    const cmd = vi.fn(async () => ({ data: 1, error: null }));
    expect(await retryOnDeadlock(cmd, { sleep: noSleep })).toEqual({ data: 1, error: null });
    expect(cmd).toHaveBeenCalledTimes(1);
  });

  it("retries a deadlock exactly once and returns the second result", async () => {
    const cmd = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: dead })
      .mockResolvedValueOnce({ data: "ok", error: null });
    const onRetry = vi.fn();
    expect(await retryOnDeadlock(cmd, { sleep: noSleep, onRetry })).toEqual({ data: "ok", error: null });
    expect(cmd).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledWith(1);
  });

  it("is bounded: at most two retries, then the last deadlock is returned unchanged", async () => {
    const cmd = vi.fn(async () => ({ data: null, error: dead }));
    const onRetry = vi.fn();
    const out = await retryOnDeadlock(cmd, { sleep: noSleep, onRetry });
    expect(out.error).toBe(dead);
    expect(MAX_DEADLOCK_RETRIES).toBe(2);
    expect(cmd).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls).toEqual([[1], [2]]);
  });

  it("succeeds on the second retry", async () => {
    const cmd = vi
      .fn()
      .mockResolvedValueOnce({ error: dead })
      .mockResolvedValueOnce({ error: dead })
      .mockResolvedValueOnce({ data: "ok", error: null });
    expect(await retryOnDeadlock(cmd, { sleep: noSleep })).toEqual({ data: "ok", error: null });
    expect(cmd).toHaveBeenCalledTimes(3);
  });

  it("maxRetries is honoured but clamped to the hard cap", async () => {
    const mk = () => vi.fn(async () => ({ error: dead }));
    const zero = mk(); await retryOnDeadlock(zero, { sleep: noSleep, maxRetries: 0 });
    expect(zero).toHaveBeenCalledTimes(1);
    const one = mk(); await retryOnDeadlock(one, { sleep: noSleep, maxRetries: 1 });
    expect(one).toHaveBeenCalledTimes(2);
    for (const maxRetries of [3, 99, Infinity]) {
      const c = mk(); await retryOnDeadlock(c, { sleep: noSleep, maxRetries });
      expect(c, String(maxRetries)).toHaveBeenCalledTimes(3);
    }
    const neg = mk(); await retryOnDeadlock(neg, { sleep: noSleep, maxRetries: -5 });
    expect(neg).toHaveBeenCalledTimes(1);
  });

  it("backs off with a growing, short pause per retry", async () => {
    const sleep = vi.fn(noSleep);
    await retryOnDeadlock(async () => ({ error: dead }), { sleep });
    expect(sleep.mock.calls).toEqual([[1], [2]]);
  });

  it.each([
    ["serialization failure", "40001"],
    ["lock timeout", "55P03"],
    ["seat limit reached", "P0001"],
    ["unique violation", "23505"],
  ])("never retries %s", async (_n, code) => {
    const err = { code };
    const cmd = vi.fn(async () => ({ data: null, error: err }));
    const onRetry = vi.fn();
    const out = await retryOnDeadlock(cmd, { sleep: noSleep, onRetry });
    expect(out.error).toBe(err);
    expect(cmd).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("sleeps between the attempts, and only when it retries", async () => {
    const sleep = vi.fn(noSleep);
    await retryOnDeadlock(async () => ({ error: null }), { sleep });
    expect(sleep).not.toHaveBeenCalled();
    const cmd = vi.fn().mockResolvedValueOnce({ error: dead }).mockResolvedValueOnce({ error: null });
    await retryOnDeadlock(cmd, { sleep });
    expect(sleep).toHaveBeenCalledOnce();
  });
});

describe("retryThrownDeadlock (thrown errors)", () => {
  it("retries a thrown deadlock once and returns the second value", async () => {
    const cmd = vi.fn().mockRejectedValueOnce(dead).mockResolvedValueOnce("ok");
    expect(await retryThrownDeadlock(cmd, { sleep: noSleep })).toBe("ok");
    expect(cmd).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last deadlock after exactly three attempts", async () => {
    const cmd = vi.fn().mockRejectedValue(dead);
    await expect(retryThrownDeadlock(cmd, { sleep: noSleep })).rejects.toBe(dead);
    expect(cmd).toHaveBeenCalledTimes(3);
  });

  it("rethrows anything else immediately", async () => {
    const other = { code: "55P03" };
    const cmd = vi.fn().mockRejectedValue(other);
    await expect(retryThrownDeadlock(cmd, { sleep: noSleep })).rejects.toBe(other);
    expect(cmd).toHaveBeenCalledTimes(1);
  });
});

describe("the message a person sees", () => {
  it("is stable and carries no SQLSTATE, SQL or internal vocabulary", () => {
    expect(userMessageForDeadlock(dead)).toBe(TRY_AGAIN_MESSAGE);
    expect(TRY_AGAIN_MESSAGE).not.toMatch(/40P01|deadlock|lock|sql|postgres|trigger|practitioner|studio|transaction/i);
  });
  it("is null for any other error, so real answers keep their own message", () => {
    for (const e of [{ code: "P0001" }, { code: "40001" }, new Error("x"), null]) {
      expect(userMessageForDeadlock(e)).toBeNull();
    }
  });
});
