import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { remote } from "webdriverio";

export type Rect = { x: number; y: number; width: number; height: number };
export type Foreground = { packageName: string; activity: string };

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const APPIUM_HOME = join(PROJECT_ROOT, ".appium");
const APPIUM_PORT = 4723;
const SERVER_START_MS = 60_000;
const KEYCODE_BACK = 4;
const KEYCODE_ENTER = 66;
const REQUEST_TIMEOUT_MS = 60_000;

/** Drives one Android device through Appium's UiAutomator2 driver, which reads the UI without waiting for it to idle. */
export class AndroidDevice {
  private constructor(
    private readonly driver: WebdriverIO.Browser,
    private readonly server: Bun.Subprocess | null,
    readonly id: string,
    readonly viewport: { width: number; height: number },
    // The rows not covered by the status and navigation bars; a tap under a bar reaches the system, not the app.
    readonly appArea: { top: number; bottom: number },
  ) {}

  static async connect(requestedId?: string): Promise<AndroidDevice> {
    if (!existsSync(join(APPIUM_HOME, "node_modules/appium-uiautomator2-driver"))) {
      throw new Error("The Appium UiAutomator2 driver is not installed; run `APPIUM_HOME=.appium bunx appium driver install uiautomator2` once");
    }
    const online = (await adb(["devices"])).split("\n").slice(1).map((line) => line.split("\t"))
      .filter(([, state]) => state?.trim() === "device").map(([id]) => id!);
    const id = requestedId ?? (online.length === 1 ? online[0] : undefined);
    if (!id || !online.includes(id)) throw new Error(`Choose an online Android device with --device. Available: ${online.join(", ") || "none"}`);
    // Mobile MCP's device server holds the single UiAutomation connection that UiAutomator2 also needs.
    await adb(["-s", id, "shell", "pkill", "-f", "com.mobilenext.mobilecli.DeviceServer"]);
    const server = await isServerReady() ? null : await startServer();
    const driver = await remote({
      hostname: "127.0.0.1", port: APPIUM_PORT, logLevel: "error",
      // Fail a hung request quickly so the explorer can recover, instead of waiting through long retries.
      connectionRetryTimeout: REQUEST_TIMEOUT_MS, connectionRetryCount: 1,
      capabilities: {
        platformName: "Android",
        "appium:automationName": "UiAutomator2",
        "appium:udid": id,
        "appium:noReset": true,
        "appium:newCommandTimeout": 900,
        // Animated screens never go idle; waiting for idle is what stalled the previous device layer.
        "appium:settings[waitForIdleTimeout]": 0,
        // Children of scroll containers below the fold are part of the page, so read them too.
        "appium:settings[allowInvisibleElements]": true,
      } as WebdriverIO.Capabilities,
    });
    const size = await driver.getWindowSize();
    const bars = await driver.execute("mobile: getSystemBars", {}) as Record<"statusBar" | "navigationBar", Rect & { visible: boolean }>;
    const appArea = {
      top: bars.statusBar.visible ? bars.statusBar.y + bars.statusBar.height : 0,
      bottom: bars.navigationBar.visible ? bars.navigationBar.y : size.height,
    };
    return new AndroidDevice(driver, server, id, { width: size.width, height: size.height }, appArea);
  }

  source(): Promise<string> {
    return this.driver.getPageSource();
  }

  async screenshot(path: string): Promise<void> {
    await this.driver.saveScreenshot(path);
  }

  async foreground(): Promise<Foreground> {
    const [packageName, activity] = await Promise.all([this.driver.getCurrentPackage(), this.driver.getCurrentActivity()]);
    return { packageName, activity };
  }

  async appVersion(packageId: string): Promise<string | null> {
    return (await adb(["-s", this.id, "shell", "dumpsys", "package", packageId])).match(/versionName=(\S+)/)?.[1] ?? null;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.driver.execute("mobile: clickGesture", { x: Math.round(x), y: Math.round(y) });
  }

  /** Types into the focused input, the one the preceding tap selected. */
  async type(text: string): Promise<void> {
    await this.driver.execute("mobile: type", { text });
  }

  async press(key: "BACK" | "ENTER"): Promise<void> {
    await this.driver.execute("mobile: pressKey", { keycode: key === "BACK" ? KEYCODE_BACK : KEYCODE_ENTER });
  }

  /** Scrolls the content inside `area`; returns false when it cannot scroll further that way. */
  async scroll(area: Rect, direction: "up" | "down"): Promise<boolean> {
    return this.driver.execute("mobile: scrollGesture", {
      left: area.x, top: area.y, width: area.width, height: area.height, direction, percent: 0.85,
    }) as Promise<boolean>;
  }

  async launch(packageId: string): Promise<void> {
    await this.driver.execute("mobile: activateApp", { appId: packageId });
  }

  async terminate(packageId: string): Promise<void> {
    await this.driver.execute("mobile: terminateApp", { appId: packageId });
  }

  async close(): Promise<void> {
    await this.driver.deleteSession().catch(() => undefined);
    this.server?.kill();
  }
}

async function isServerReady(): Promise<boolean> {
  try {
    return ((await (await fetch(`http://127.0.0.1:${APPIUM_PORT}/status`)).json()) as { value?: { ready?: boolean } }).value?.ready === true;
  } catch {
    return false;
  }
}

async function startServer(): Promise<Bun.Subprocess> {
  const logFile = join(PROJECT_ROOT, "data", "appium.log");
  mkdirSync(dirname(logFile), { recursive: true });
  const server = Bun.spawn([join(PROJECT_ROOT, "node_modules/.bin/appium"), "--port", String(APPIUM_PORT), "--log", logFile, "--log-no-colors"], {
    env: { ...toolEnvironment(), APPIUM_HOME }, stdout: "ignore", stderr: "ignore",
  });
  for (const deadline = Date.now() + SERVER_START_MS; Date.now() < deadline; await Bun.sleep(500)) {
    if (await isServerReady()) return server;
  }
  server.kill();
  throw new Error("Appium did not start; see data/appium.log");
}

async function adb(args: string[]): Promise<string> {
  const child = Bun.spawn(["adb", ...args], { env: toolEnvironment(), stdout: "pipe", stderr: "pipe" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return stdout;
}

function toolEnvironment(): Record<string, string> {
  const androidHome = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
  return { ...process.env, ANDROID_HOME: androidHome, PATH: `${join(androidHome, "platform-tools")}:${process.env.PATH ?? ""}` } as Record<string, string>;
}
