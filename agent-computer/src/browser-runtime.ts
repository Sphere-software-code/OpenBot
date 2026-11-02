import { type BrowserMode, browserModeFromEnv } from "./browser-mode";

export type BrowserRuntime = {
  backend: "managed" | "local-chrome" | "kernel";
  channel: "chromium" | "chrome";
  mode: BrowserMode;
  useVirtualDisplay: boolean;
  hostname?: string;
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
  // Where the HTTP process listens. Native Chrome always listens on loopback. A managed computer listens on every interface unless COMPUTER_BIND names an address,
  // so a computer that runs on a person's own machine (not in a container) can be kept off the network: COMPUTER_BIND=127.0.0.1.
  const bind = env.COMPUTER_BIND?.trim();
  /*
   * Headed wherever a hosted computer runs, which is Linux: a container, a Kubernetes pod, the
   * desktop app's Podman machine. Headless Chromium is the browser bot checks are best at spotting
   * (it says `HeadlessChrome`, renders without a GPU path a person's browser has, and is missing what
   * a windowed browser has), and Cloudflare in front of ChatGPT, Canva and the like challenges it on
   * sight. The window goes to the in-container X server (`virtual-display.ts`), so nothing appears
   * anywhere and the live screen is unchanged. A developer running this directly on a Mac or Windows
   * keeps headless, where a headed default would open windows on their desktop.
   * `COMPUTER_BROWSER_MODE=headless` still chooses headless anywhere.
   */
  const mode = browserModeFromEnv(
    env.COMPUTER_BROWSER_MODE?.trim() ||
      (local || platform === "linux" ? "headed" : "headless"),
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
    ...(local ? { hostname: "127.0.0.1" } : bind ? { hostname: bind } : {}),
    allowExec: !local,
  };
}
