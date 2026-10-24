import { describe, expect, it, vi } from "vitest";
import { isValidElement } from "react";

// Codex P2 4367401278: the records retry control must re-request the server
// render (router.refresh()), never navigate to the URL already on screen.

const refresh = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push, replace: push }) }));

const { RefreshRetryButton } = await import("@/app/(app)/records/refresh-retry-button");

describe("RefreshRetryButton", () => {
  it("is a button whose click calls router.refresh() and navigates nowhere", () => {
    const el = RefreshRetryButton({});
    expect(isValidElement(el)).toBe(true);
    const props = (el as { type: unknown; props: Record<string, unknown> }).props;
    expect((el as { type: unknown }).type).toBe("button");
    expect(props.type).toBe("button");
    expect(props.href).toBeUndefined();
    expect(props.children).toBe("Try again");
    (props.onClick as () => void)();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
