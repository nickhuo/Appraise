import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

import { AndroidDevice } from "../../src/explore/device.ts";
import { modelElements } from "../../src/explore/analyst.ts";
import { peek, type Capture } from "../../src/explore/page.ts";

const { values } = parseArgs({ options: {
  "mobile-mcp": { type: "string" }, device: { type: "string" }, "mobile-device": { type: "string" },
  output: { type: "string", default: "data/tree-benchmark" },
} });
if (!values["mobile-mcp"] || !values.device || !values["mobile-device"] || !process.env.MOBILECLI_PATH) {
  throw new Error("Provide --mobile-mcp <package directory>, --device <adb serial>, --mobile-device <mobilecli id> and MOBILECLI_PATH");
}
const packageRoot = resolve(values["mobile-mcp"]);
const { MobileDevice } = await import(join(packageRoot, "lib/mobile-device.js"));
const { Mobilecli } = await import(join(packageRoot, "lib/mobilecli.js"));
const { formatElements } = await import(join(packageRoot, "lib/format-elements.js"));
const mobile = new MobileDevice(values["mobile-device"]);
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const apps: Record<string, string> = JSON.parse(await readFile("apps.json", "utf8"));
const metadata = {
  startedAt: new Date().toISOString(), device: values.device, mobileDevice: values["mobile-device"],
  mobileMcpVersion: JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version,
  mobilecliVersion: new Mobilecli().getVersion(),
  appiumVersion: JSON.parse(await readFile("node_modules/appium/package.json", "utf8")).version,
  driverVersion: JSON.parse(await readFile(".appium/node_modules/appium-uiautomator2-driver/package.json", "utf8")).version,
  settings: { waitForIdleTimeout: 0, allowInvisibleElements: true },
  samples: [] as { app: string; packageId: string; beforeMs: number; mobileMs: number; afterMs: number; sameAppiumSource: boolean }[],
};

for (const [app, packageId] of Object.entries(apps)) {
  const directory = join(output, app);
  await mkdir(directory, { recursive: true });
  const device = await AndroidDevice.connect(values.device);
  let before: string;
  let beforeMs: number;
  try {
    await device.launch(packageId);
    await Bun.sleep(2000);
    const start = performance.now();
    const view = await peek(device);
    beforeMs = performance.now() - start;
    before = view.source;
    await writeFile(join(directory, "appium.xml"), before);
    await writeFile(join(directory, "view.json"), JSON.stringify(view, null, 2));
    await device.screenshot(join(directory, "screen.png"));
  } finally {
    await device.close();
  }
  const start = performance.now();
  // These are the exact backend and formatter called by mobile_list_elements_on_screen.
  const elements = await mobile.getElementsOnScreen();
  const mobileMs = performance.now() - start;
  await writeFile(join(directory, "mobile-elements.json"), JSON.stringify(elements, null, 2));
  await writeFile(join(directory, "mobile.txt"), formatElements(elements, "text"));
  await writeFile(join(directory, "mobile.json.txt"), formatElements(elements, "json"));
  const afterDevice = await AndroidDevice.connect(values.device);
  let after: string;
  let afterMs: number;
  try {
    const start = performance.now();
    after = await afterDevice.source();
    afterMs = performance.now() - start;
    await writeFile(join(directory, "appium-after.xml"), after);
  } finally {
    await afterDevice.close();
  }
  metadata.samples.push({ app, packageId, beforeMs, mobileMs, afterMs, sameAppiumSource: before === after });
  await writeFile(join(output, "capture-metadata.json"), JSON.stringify(metadata, null, 2));
  console.log(`${app}: captured Appium / Mobile MCP / Appium`);
}

const corpus: { app: string; graph: string; source: string; text: string }[] = [];
for await (const path of new Bun.Glob("runs/*/*/graph.json").scan(".")) {
  const graph = JSON.parse(await readFile(path, "utf8")) as { app: { key: string }; captures: Record<string, Capture> };
  for (const capture of Object.values(graph.captures)) {
    // Match analyst.ts's model-facing serialization, including repeated-card sampling.
    const text = modelElements(capture).map((element) => {
      const flags = `${element.enabled ? "" : " disabled"}${element.onScreen ? "" : " below"}`;
      const id = element.resourceId ? ` id=${element.resourceId.slice(element.resourceId.indexOf("/") + 1)}` : "";
      return `${element.number} ${element.kind} ${JSON.stringify(element.name.slice(0, 80))} ${element.className}${id}${flags}`;
    }).join("\n");
    corpus.push({ app: graph.app.key, graph: path, source: capture.source, text });
  }
}
await writeFile(join(output, "current-model-corpus.json"), JSON.stringify(corpus, null, 2));
