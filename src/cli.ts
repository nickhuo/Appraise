import { resolve, join } from "node:path";
import { parseArgs } from "node:util";

import { setTracingDisabled } from "@openai/agents";

import { AndroidDevice } from "./explore/device.ts";
import { exploreApp } from "./explore/explore.ts";
import { runPresent } from "./present/present.ts";
import { runRecreate } from "./recreate/recreate.ts";
import { runRecommend } from "./recommend/recommend.ts";

const projectRoot = resolve(import.meta.dir, "..");
const [command, ...argumentsList] = process.argv.slice(2);

if (command !== "explore" && command !== "recreate" && command !== "recommend" && command !== "present") {
  console.error("Usage: bun run src/cli.ts explore --app <name> [--package <id>] [--device <id>] [--max-actions 30] [--model <id>]\n       bun run src/cli.ts recreate --app <name> --run <run-id>\n       bun run src/cli.ts recommend --app <name> --run <run-id> [--context <file>] [--previous-dir <dir>] [--model <id>]\n       bun run src/cli.ts present --demo\n       bun run src/cli.ts present --app <name> --run <run-id> --recommend-dir <dir> --mock-dir <dir> [--proposal-id <id>]");
  process.exit(2);
}

if (command === "explore") {
  setTracingDisabled(true);
  const { values } = parseArgs({
    args: argumentsList,
    options: { app: { type: "string" }, package: { type: "string" }, device: { type: "string" }, "max-actions": { type: "string" }, model: { type: "string" } },
    strict: true,
  });
  if (!values.app || !/^[a-z0-9_-]+$/.test(values.app)) throw new Error("--app must be a lowercase name containing letters, numbers, _ or -");
  const knownApps = await Bun.file(join(projectRoot, "apps.json")).json() as Record<string, string>;
  const packageId = values.package ?? knownApps[values.app];
  if (!packageId) throw new Error(`No package ID for ${values.app}; pass --package`);
  const maxActions = Number(values["max-actions"] ?? 30);
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 200) throw new Error("--max-actions must be an integer from 1 to 200");
  const device = await AndroidDevice.connect(values.device);
  const graph = await exploreApp({
    appKey: values.app, packageId, device, projectRoot, maxActions, model: values.model, log: (line) => console.error(line),
  }).finally(() => device.close());
  console.log(JSON.stringify({
    runId: graph.runId, status: graph.status, reason: graph.reason, states: graph.states.length, edges: graph.edges.length,
    viewer: join("runs", values.app, graph.runId, "index.html"),
  }, null, 2));
} else if (command === "recreate") {
  const { values } = parseArgs({
    args: argumentsList,
    options: { app: { type: "string" }, run: { type: "string" } },
    strict: true,
  });
  if (!values.app || !values.run) throw new Error("Recreate requires --app and --run");
  const recreated = await runRecreate({
    projectRoot,
    appKey: values.app,
    runId: values.run,
  });
  console.log(JSON.stringify(recreated, null, 2));
} else if (command === "recommend") {
  const { values } = parseArgs({
    args: argumentsList,
    options: { app: { type: "string" }, run: { type: "string" }, context: { type: "string" }, "previous-dir": { type: "string" }, model: { type: "string" } },
    strict: true,
  });
  if (!values.app || !values.run) throw new Error("Recommend requires --app and --run");
  const recommended = await runRecommend({
    projectRoot,
    appKey: values.app,
    runId: values.run,
    contextPath: values.context,
    previousDirectory: values["previous-dir"],
    model: values.model,
  });
  console.log(JSON.stringify(recommended, null, 2));
} else if (command === "present") {
  const { values } = parseArgs({
    args: argumentsList,
    options: {
      demo: { type: "boolean" }, app: { type: "string" }, run: { type: "string" },
      "recommend-dir": { type: "string" }, "mock-dir": { type: "string" }, "proposal-id": { type: "string" },
    },
    strict: true,
  });
  const presented = await runPresent({
    projectRoot, demo: values.demo, appKey: values.app, runId: values.run,
    recommendationDirectory: values["recommend-dir"], mockDirectory: values["mock-dir"],
    proposalId: values["proposal-id"],
  });
  console.log(JSON.stringify(presented, null, 2));
}
