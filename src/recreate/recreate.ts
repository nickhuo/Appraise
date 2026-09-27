import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { z } from "zod";

import type { MockManifest, MockPreview } from "../domain/mock.ts";
import type { ScreenElement } from "../domain/observation.ts";
import { type ProductModel, validateSnapshot } from "../domain/product-model.ts";

type Bounds = { x: number; y: number; width: number; height: number };

const elementSchema = z.object({
  ref: z.string(), type: z.string(), text: z.string().optional(), label: z.string().optional(),
  name: z.string().optional(), value: z.string().optional(), identifier: z.string().optional(),
  coordinates: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().finite(), height: z.number().finite() }),
  focused: z.boolean().optional(), selected: z.boolean().optional(), checked: z.boolean().optional(), enabled: z.boolean().optional(),
}) satisfies z.ZodType<ScreenElement>;

export async function runRecreate(options: {
  projectRoot: string;
  appKey: string;
  runId: string;
}): Promise<{ runId: string; outputDirectory: string; states: number; actions: number; inputHash: string }> {
  if (!/^[a-z0-9_-]+$/.test(options.appKey) || !/^[a-zA-Z0-9_-]+$/.test(options.runId)) throw new Error("Invalid app or run ID");
  const runDirectory = await realpath(join(options.projectRoot, "runs", options.appKey, options.runId));
  const snapshotBytes = await readFile(join(runDirectory, "product-model.json"));
  const snapshot = JSON.parse(snapshotBytes.toString()) as ProductModel;
  validateSnapshot(snapshot);
  if (snapshot.app.key !== options.appKey || snapshot.runId !== options.runId) throw new Error("Product model does not match the requested run");
  const observations = snapshot.states.flatMap((state) => state.evidence.map((evidence) => ({ state, evidence })))
    .sort((left, right) => left.evidence.step - right.evidence.step);
  if (!observations.length) throw new Error("This run has no observed screens to recreate");
  const byStep = new Map(observations.map((observation) => [observation.evidence.step, observation]));
  if (byStep.size !== observations.length) throw new Error("Observation steps must uniquely identify screenshots");
  for (const transition of snapshot.transitions) {
    const source = byStep.get(transition.evidence.step)!;
    if (source.state.id !== transition.from || source.evidence.screenshot !== transition.evidence.screenshot || source.evidence.elementTree !== transition.evidence.elementTree) {
      throw new Error(`Transition ${transition.id} does not match its source observation`);
    }
    if (transition.to !== null && byStep.get(transition.destinationStep ?? transition.evidence.step + 1)?.state.id !== transition.to) {
      throw new Error(`Transition ${transition.id} has no matching next observation`);
    }
  }
  const manifest: MockManifest = {
    version: 4, runId: snapshot.runId, inputHash: "", app: snapshot.app.key,
    runStatus: snapshot.runStatus, stopReason: snapshot.stopReason,
    initialStep: observations[0]!.evidence.step,
    states: snapshot.states.map((state) => ({
      id: state.id, screen: state.screen, variant: state.variant, summary: state.summary,
      observationSteps: state.evidence.map((evidence) => evidence.step).sort((left, right) => left - right),
      entrances: [],
    })).sort((left, right) => left.observationSteps[0]! - right.observationSteps[0]!),
    observations: [], transitions: [],
  };
  const preview: MockPreview = { manifest, images: {} };
  const inputHash = createHash("sha256").update(snapshotBytes);
  for (const { state, evidence } of observations) {
    const bytes: Buffer[] = [];
    for (const path of [evidence.screenshot, evidence.elementTree]) {
      const absolutePath = await realpath(resolve(options.projectRoot, path));
      if (!absolutePath.startsWith(`${runDirectory}${sep}`)) throw new Error(`Evidence is outside this run: ${path}`);
      const content = await readFile(absolutePath);
      inputHash.update(path).update(content);
      bytes.push(content);
    }
    const [screenshotBytes, treeBytes] = bytes as [Buffer, Buffer];
    const elements = z.array(elementSchema).parse(JSON.parse(treeBytes.toString()));
    const { width, height } = state.viewport;
    // Explore writes PNGs; IHDR stores their original pixel dimensions.
    if (screenshotBytes.length < 24 || !screenshotBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
        screenshotBytes.toString("ascii", 12, 16) !== "IHDR" || !Number.isInteger(width) || !Number.isInteger(height) ||
        width <= 0 || height <= 0 || screenshotBytes.readUInt32BE(16) !== width || screenshotBytes.readUInt32BE(20) !== height) {
      throw new Error(`Screenshot dimensions do not match observation ${evidence.step}`);
    }
    manifest.observations.push({
      step: evidence.step, stateId: state.id, viewport: state.viewport,
      evidence: { screenshot: evidence.screenshot, elementTree: evidence.elementTree }, scroll: evidence.scroll,
    });
    for (const transition of snapshot.transitions.filter((item) => item.evidence.step === evidence.step)) {
      const { action } = transition;
      if (!["tap", "type", "swipe", "back", "wait"].includes(action.type)) throw new Error(`Unsupported action on ${transition.id}`);
      if (action.type === "type" && (typeof action.text !== "string" || typeof action.submit !== "boolean")) throw new Error(`Invalid text input on ${transition.id}`);
      if (action.type === "swipe" && !["up", "down", "left", "right"].includes(action.direction)) throw new Error(`Invalid swipe direction on ${transition.id}`);
      const target = action.targetRef ? elements.find((element) => element.ref === action.targetRef) : undefined;
      if (action.targetRef && !target) throw new Error(`Missing action target ${action.targetRef} at step ${evidence.step}`);
      let bounds = target?.coordinates ?? null;
      if (!bounds && action.x !== null && action.y !== null) {
        if (!Number.isFinite(action.x) || !Number.isFinite(action.y)) throw new Error(`Invalid coordinates on ${transition.id}`);
        const { x, y } = action;
        // The tapped element is the smallest one under the point; a fixed square stands in when the tree has none.
        const hit = elements.filter(({ coordinates: box }) => box.x <= x && x <= box.x + box.width && box.y <= y && y <= box.y + box.height)
          .sort((left, right) => left.coordinates.width * left.coordinates.height - right.coordinates.width * right.coordinates.height)[0];
        const size = width * 0.08;
        bounds = hit?.coordinates ?? { x: x - size / 2, y: y - size / 2, width: size, height: size };
      }
      if (bounds) {
        bounds = clip(bounds, width, height);
        if (!bounds) throw new Error(`Action target is outside observation ${evidence.step}`);
      }
      if (action.type === "tap" && !bounds) throw new Error(`Missing tap coordinates on ${transition.id}`);
      manifest.transitions.push({
        id: transition.id, from: transition.from, to: transition.to,
        sourceStep: evidence.step, targetStep: transition.to === null ? null : transition.destinationStep ?? evidence.step + 1,
        action, bounds, outcome: transition.outcome,
        label: action.type === "type" ? (action.submit ? action.text === "" ? "Submit" : "Type and submit" : "Type text")
          : action.type === "swipe" ? `Swipe ${action.direction}`
          : action.type === "back" ? (bounds ? "In-app back" : "Android Back")
          : action.type === "wait" ? "Wait for result"
          : target?.label || target?.text || target?.name || action.reason,
      });
    }
    preview.images[evidence.screenshot] = `data:image/png;base64,${screenshotBytes.toString("base64")}`;
  }
  for (const mockState of manifest.states) {
    const state = snapshot.states.find((item) => item.id === mockState.id)!;
    const outgoing = manifest.transitions.filter((transition) => transition.from === state.id);
    mockState.entrances = state.groups.map((group) => {
      const transition = outgoing.find((item) => item.action.groupKey === group.key);
      const status = group.status ?? (group.explored ? "explored" : group.coverage === "pending" ? "pending" : "blocked");
      const location = group.location;
      const observation = location?.onScreen ? manifest.observations.find((item) => item.step === location.step) : undefined;
      const bounds = observation && location ? clip(location.bounds, observation.viewport.width, observation.viewport.height) : null;
      // Entrances are drawn where the analyst chose them, so a state's entrances share one frame; a tap that first had to
      // scroll uses the scrolled frame it was made on.
      const placed = bounds ? { step: location!.step, bounds } : transition ? { step: transition.sourceStep, bounds: transition.bounds } : null;
      return {
        key: group.key, name: group.description, status, transitionId: transition?.id ?? null,
        step: placed?.step ?? null, bounds: placed?.bounds ?? null,
      };
    });
    // Older models record some transitions without a matching group; they are still actions of the state.
    for (const transition of outgoing.filter((item) => !state.groups.some((group) => group.key === item.action.groupKey))) {
      mockState.entrances.push({ key: transition.id, name: transition.label, status: "explored", transitionId: transition.id, step: transition.sourceStep, bounds: transition.bounds });
    }
  }
  const build = await Bun.build({ entrypoints: [new URL("./replay.tsx", import.meta.url).pathname], target: "browser", format: "iife", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
  if (!build.success) throw new Error(`Mock runtime build failed: ${build.logs.join("\n")}`);
  const script = (await build.outputs[0]!.text()).replace(/<\/script/gi, "<\\/script");
  const template = await readFile(new URL("./index.html", import.meta.url), "utf8");
  inputHash.update(JSON.stringify(manifest)).update(template).update(script);
  manifest.inputHash = inputHash.digest("hex");
  const outputDirectory = join(runDirectory, "mock", manifest.inputHash);
  const payload = JSON.stringify(preview).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(outputDirectory, "index.html"), template.replace(/__MOCK_(DATA|SCRIPT)__/g, (_match, kind: string) => kind === "DATA" ? payload : script));
  return { runId: snapshot.runId, outputDirectory, states: manifest.states.length, actions: manifest.transitions.length, inputHash: manifest.inputHash };
}

function clip(bounds: Bounds, width: number, height: number): Bounds | null {
  const left = Math.max(0, bounds.x);
  const top = Math.max(0, bounds.y);
  const clipped = { x: left, y: top, width: Math.min(width, bounds.x + bounds.width) - left, height: Math.min(height, bounds.y + bounds.height) - top };
  return clipped.width > 0 && clipped.height > 0 ? clipped : null;
}
