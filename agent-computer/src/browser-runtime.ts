import { browserModeFromEnv, type BrowserMode } from "./browser-mode";

export type BrowserRuntime = {
  backend: "managed" | "local-chrome" | "kernel";
  channel: "chromium" | "chrome";
  mode: BrowserMode;
  useVirtualDisplay: boolean;
  hostname?: "127.0.0.1";
  allowExec: boolean;
  /** Where a kernel browser answers CDP, with `{bot}` standing for the Bot id. Kernel only. */
  cdpUrl?: string;
};

/** One kernel container per Bot, reached by name on a network the two share. */
const DEFAULT_KERNEL_CDP_URL = "http://kernel-{bot}:9222";

/** The same launch decision is used by profiles and the computer HTTP process. */
export function browserRuntimeFromEnv(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
): BrowserRuntime {
  const backend = env.COMPUTER_BROWSER_BACKEND?.trim() || "managed";
  if (
    backend !== "managed" &&
    backend !== "local-chrome" &&
    backend !== "kernel"
  ) {
    throw new Error(
      "COMPUTER_BROWSER_BACKEND must be managed, local-chrome or kernel.",
    );
  }
  if (backend === "kernel") {
    // Headed on kernel's own display, in kernel's container, so nothing here starts a browser or a
    // display. COMPUTER_BROWSER_MODE is ignored rather than checked: the supervisor forwards
    // `headless` to every computer it makes, and that is not a statement about this browser.
    return {
      backend,
      channel: "chromium",
      mode: "headed",
      useVirtualDisplay: false,
      allowExec: true,
      cdpUrl: env.COMPUTER_KERNEL_CDP_URL?.trim() || DEFAULT_KERNEL_CDP_URL,
    };
  }
  const local = backend === "local-chrome";
  const mode = browserModeFromEnv(
    env.COMPUTER_BROWSER_MODE?.trim() || (local ? "headed" : "headless"),
  );
  if (local && mode !== "headed") {
    throw new Error(
      "COMPUTER_BROWSER_BACKEND=local-chrome requires COMPUTER_BROWSER_MODE=headed.",
    );
  }
  return {
    backend,
    channel: local ? "chrome" : "chromium",
    mode,
    useVirtualDisplay: platform === "linux" && mode === "headed",
    ...(local ? { hostname: "127.0.0.1" as const } : {}),
    allowExec: !local,
  };
}
