// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
const save=vi.fn(); const refresh=vi.fn();
vi.mock("@/app/(app)/settings/studio/actions",()=>({setStudioManagedAppointmentsAction:(...args:unknown[])=>save(...args)}));
vi.mock("next/navigation",()=>({useRouter:()=>({refresh})}));
const {StudioManagedAppointmentsControl}=await import("@/app/(app)/settings/studio/StudioManagedAppointmentsControl");
(globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
let host:HTMLDivElement; let root:ReturnType<typeof createRoot>;
beforeEach(()=>{save.mockReset();refresh.mockReset();host=document.createElement("div");document.body.appendChild(host);root=createRoot(host)});
afterEach(()=>{act(()=>root.unmount());host.remove()});
async function mount(initial=false,available=true){await act(async()=>root.render(createElement(StudioManagedAppointmentsControl,{initial,available})));return host.querySelector("button")!}
describe("studio-managed appointments control",()=>{
 it("is unavailable before rollout and sends no command",async()=>{const button=await mount(false,false);expect(button.disabled).toBe(true);expect(host.textContent).toContain("not available yet");await act(async()=>button.click());expect(save).not.toHaveBeenCalled()});
 it("acknowledges while pending and confirms only after successful save",async()=>{let resolve!:(x:unknown)=>void;save.mockReturnValue(new Promise(r=>resolve=r));const button=await mount();await act(async()=>button.click());expect(button.disabled).toBe(true);expect(button.getAttribute("aria-pressed")).toBe("false");expect(host.textContent).not.toContain("Saved.");await act(async()=>resolve({ok:true}));expect(button.getAttribute("aria-pressed")).toBe("true");expect(save.mock.calls[0][0].get("studio_managed_appointments")).toBe("true");expect(refresh).toHaveBeenCalledOnce()});
 it("failed save leaves the original state and allows retry",async()=>{save.mockResolvedValue({ok:false,error:"Try again"});const button=await mount(true);await act(async()=>button.click());expect(button.getAttribute("aria-pressed")).toBe("true");expect(button.disabled).toBe(false);expect(host.querySelector('[role="alert"]')?.textContent).toBe("Try again");expect(refresh).not.toHaveBeenCalled()});
});
