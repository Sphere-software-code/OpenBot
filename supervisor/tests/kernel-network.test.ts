import { describe, expect, test } from "bun:test";
import { kernelNetworkFor, kernelNetworkTemplate } from "../src/kernel-network";

/**
 * The network a computer joins is derived from its Bot id, like every other name the supervisor
 * uses. A deployment may change the pattern or turn it off; it never gets to name one network for
 * every computer, and a caller never gets to name one at all.
 */
describe("the kernel network a computer joins", () => {
  test("unset and blank are <namespace>-kernel-<bot>, the networks the kernel scripts make", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(kernelNetworkTemplate(raw, "openbot")).toEqual({
        ok: true,
        template: "openbot-kernel-{bot}",
      });
    }
    expect(kernelNetworkFor("openbot-kernel-{bot}", "outreach")).toBe(
      "openbot-kernel-outreach",
    );
  });

  test("follows the deployment's namespace", () => {
    const resolved = kernelNetworkTemplate(undefined, "staging");
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(kernelNetworkFor(resolved.template, "agent_2aaf8f2f-0e53")).toBe(
      "staging-kernel-agent_2aaf8f2f-0e53",
    );
  });

  test("off joins nothing", () => {
    expect(kernelNetworkTemplate("off", "openbot")).toEqual({
      ok: true,
      template: undefined,
    });
    expect(kernelNetworkTemplate(" off ", "openbot")).toEqual({
      ok: true,
      template: undefined,
    });
    expect(kernelNetworkFor(undefined, "outreach")).toBeUndefined();
  });

  test("a pattern of the deployment's own is used as given, trimmed", () => {
    expect(kernelNetworkTemplate("  browsers_{bot}-net ", "openbot")).toEqual({
      ok: true,
      template: "browsers_{bot}-net",
    });
    expect(kernelNetworkFor("browsers_{bot}-net", "sales")).toBe(
      "browsers_sales-net",
    );
    // The id may come first: every valid one starts with a letter or digit.
    expect(kernelNetworkTemplate("{bot}-kernel", "openbot").ok).toBe(true);
    expect(kernelNetworkFor("{bot}-kernel", "sales")).toBe("sales-kernel");
  });

  test("a pattern without {bot} is refused, because every computer would share it", () => {
    // One network for every computer would let each Bot's shell reach every other Bot's browser.
    for (const raw of ["openbot_default", "openbot-kernel-", "OFF", "{Bot}"]) {
      const result = kernelNetworkTemplate(raw, "openbot");
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.reason).toContain("COMPUTER_KERNEL_NETWORK");
    }
  });

  test("characters a derived name may not carry are refused", () => {
    for (const raw of [
      "../{bot}", // a path
      "net/{bot}", // another segment on the socket API
      "net.{bot}", // dots invite `..` reasoning, as for ids
      "net {bot}",
      "net:{bot}",
      "-net-{bot}", // must start with a letter or digit
      "_{bot}",
      "net-{bot", // half a placeholder
      "net-{bot}}",
      "{{bot}}",
    ]) {
      expect(kernelNetworkTemplate(raw, "openbot").ok).toBe(false);
    }
  });
});
