import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Model } from "@openai/agents";

import { Analyst, type KnownScreen, modelElements } from "./analyst.ts";
import type { AndroidDevice } from "./device.ts";
import {
  difference, type Entrance, type Graph, type GraphEdge, type GraphState, type Locator, locatorOf, namedElements, newMonetization, routeToScreen,
  toEntrances, toProductModel,
} from "./graph.ts";
import { capture, isSameState, peek, reveal } from "./page.ts";

const POST_ACTION_MS = 800;
const LOADING_POLL_MS = 3_000;
const MAX_LOADING_MS = 90_000;
const MAX_ALTERNATIVES = 2;
const SLOW_TRANSITION_MS = 1_200;
const MAX_REPLANS = 2;
const MAX_DEVICE_RECOVERIES = 3;

type Arrival = { kind: "state"; stateId: string; step: number } | { kind: "outside"; packageName: string } | { kind: "timeout" };
type Tap = { x: number; y: number; sourceStep: number };
type Attempt = ({ kind: "arrived"; stateId: string; step: number } & Tap) | ({ kind: "outside"; packageName: string } & Tap)
  | { kind: "no_effect" } | { kind: "missing" } | { kind: "disabled" } | { kind: "timeout" } | { kind: "moved" };

class OutOfBudget extends Error {}

// A UiAutomator2 request that hangs (a huge or churning page) surfaces as a timeout; restarting the app usually clears it.
const isDeviceTimeout = (error: unknown) => error instanceof Error && /timed out|timeout/i.test(error.message);

export async function exploreApp(options: {
  appKey: string;
  packageId: string;
  device: AndroidDevice;
  projectRoot: string;
  maxActions: number;
  model?: string | Model;
  log?: (line: string) => void;
}): Promise<Graph> {
  const { device, packageId, projectRoot } = options;
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
  const runDirectory = join(projectRoot, "runs", options.appKey, runId);
  const captureDirectory = join(runDirectory, "captures");
  await mkdir(captureDirectory, { recursive: true });
  const analyst = new Analyst(options.model ?? process.env.OPENAI_MODEL ?? "gpt-6-sol", options.appKey, projectRoot);
  const graph: Graph = {
    runId, app: { key: options.appKey, packageId, version: null }, status: "running", reason: "", startedAt: new Date().toISOString(),
    viewport: device.viewport,
    root: null, budget: { used: 0, max: options.maxActions }, screens: [], states: [], edges: [], captures: {}, usage: analyst.usage,
  };
  let step = 0;
  let current: string | null = null;
  let path: string[] = [];

  const stateById = (id: string) => graph.states.find((state) => state.id === id)!;
  const screenOf = (id: string) => stateById(id).screenId;
  const screenName = (screenId: string) => graph.screens.find((screen) => screen.id === screenId)!.name;
  const label = (id: string) => `${screenName(screenOf(id))}/${stateById(id).variant}`;
  // Pending work belongs to a screen: another state of it (another character, another article) is the same place.
  const pendingOn = (screenId: string) => graph.states.filter((state) => state.screenId === screenId)
    .flatMap((state) => state.entrances).find((entrance) => entrance.status === "pending");
  const log = async (line: string) => {
    const stamped = `${new Date().toTimeString().slice(0, 8)} ${line}`;
    options.log?.(stamped);
    await appendFile(join(runDirectory, "explore.log"), `${stamped}\n`);
  };
  const save = async () => {
    await writeFile(join(runDirectory, "graph.json"), JSON.stringify(graph, null, 1));
    if (graph.states.length > 0) await writeFile(join(runDirectory, "product-model.json"), `${JSON.stringify(toProductModel(graph), null, 2)}\n`);
  };
  const knownScreens = (): KnownScreen[] => graph.screens.map((screen) => ({
    ...screen, variants: graph.states.filter((state) => state.screenId === screen.id).map((state) => state.variant),
  }));
  const spend = () => {
    if (graph.budget.used >= graph.budget.max) throw new OutOfBudget();
    graph.budget.used++;
  };

  // Looks at the screen after an action or launch: waits out loading, then finds or creates the state.
  async function observe(): Promise<Arrival> {
    const deadline = Date.now() + MAX_LOADING_MS;
    for (;;) {
      const view = await peek(device);
      if (view.foreground.packageName !== packageId) return { kind: "outside", packageName: view.foreground.packageName };
      if (view.loading && Date.now() < deadline) {
        await log(`  loading (progress indicator), waiting ${LOADING_POLL_MS / 1000}s`);
        await Bun.sleep(LOADING_POLL_MS);
        continue;
      }
      const evidence = await capture(device, { directory: captureDirectory, projectRoot, step: step++ });
      graph.captures[evidence.step] = evidence;
      const matches = graph.states.filter((state) => state.activity === evidence.foreground.activity && isSameState(state, evidence));
      const known = matches.find((state) => state.signature === evidence.signature) ?? matches[0];
      if (known) {
        known.steps.push(evidence.step);
        return { kind: "state", stateId: known.id, step: evidence.step };
      }
      const analysis = await analyst.analyze(evidence, knownScreens());
      if (analysis.isLoading && Date.now() < deadline) {
        // Waiting is cheap without the model: poll until what is visible stops changing (a streamed reply ended).
        await log(`step ${evidence.step}: still loading (${analysis.summary}); waiting for the screen to stop changing`);
        delete graph.captures[evidence.step];
        let previous = "";
        for (;;) {
          await Bun.sleep(LOADING_POLL_MS);
          const next = await peek(device);
          if (next.contentKey === previous || next.foreground.packageName !== packageId || Date.now() >= deadline) break;
          previous = next.contentKey;
        }
        continue;
      }
      if (analysis.isLoading) return { kind: "timeout" };
      // Action names carry content (another character, another article), so the analyst decides when a new
      // capture is a known screen in a known condition; the action sets alone cannot.
      const sameCondition = graph.states.find((state) => state.screenId === analysis.existingScreenId && state.variant === analysis.variantName);
      if (sameCondition) {
        sameCondition.steps.push(evidence.step);
        sameCondition.monetization.push(...newMonetization(sameCondition, analysis, evidence.step));
        await log(`step ${evidence.step}: ${label(sameCondition.id)} · same screen and condition, different content`);
        return { kind: "state", stateId: sameCondition.id, step: evidence.step };
      }
      let screenId = analysis.existingScreenId;
      if (!screenId) {
        screenId = `s${graph.screens.length + 1}`;
        graph.screens.push({ id: screenId, name: analysis.screenName, description: analysis.screenDescription });
      }
      const state: GraphState = {
        id: `n${graph.states.length + 1}`, screenId, variant: analysis.variantName, summary: analysis.summary,
        activity: evidence.foreground.activity, signature: evidence.signature, actionKeys: evidence.actionKeys, steps: [evidence.step],
        elements: namedElements(evidence, analysis), entrances: toEntrances(evidence, analysis, 0), monetization: [],
      };
      state.monetization = newMonetization(state, analysis, evidence.step);
      graph.states.push(state);
      await log(`step ${evidence.step}: ${label(state.id)} · new state · ${analysis.summary}`);
      if (state.monetization.length) await log(`  monetization: ${state.monetization.map((fact) => `${fact.kind}: ${fact.description}`).join(" · ")}`);
      await log(`  entrances: ${state.entrances.map((entrance) => `${entrance.name}${entrance.locator.onScreen ? "" : " (below)"}` +
        `${entrance.blockedReason ? ` (blocked: ${entrance.blockedReason})` : ""}`).join(" > ") || "none"}` +
        ` · ${modelElements(evidence).length} of ${evidence.elements.length} actions shown${evidence.settled ? "" : " · screen kept changing"}`);
      return { kind: "state", stateId: state.id, step: evidence.step };
    }
  }

  // Performs one recorded action on the current screen and reports what happened.
  async function attempt(locator: Locator, action: { text: string | null; submit: boolean }): Promise<Attempt> {
    // Time passes while the model thinks; a popup or refresh may have replaced the screen we planned for.
    const latest = graph.captures[stateById(current!).steps.at(-1)!]!;
    if (!isSameState(await peek(device), latest)) return { kind: "moved" };
    const revealed = await reveal(device, locator);
    if (!revealed) return { kind: "missing" };
    const { element, before, scrolled } = revealed;
    if (!element.enabled) return { kind: "disabled" };
    // The tap lands on the scrolled page, so keep that frame as the action's evidence for the mock.
    let sourceStep = latest.step;
    if (scrolled) {
      const frame = await capture(device, { directory: captureDirectory, projectRoot, step: step++, scroll: { from: latest.step, direction: scrolled } });
      graph.captures[frame.step] = frame;
      stateById(current!).steps.push(frame.step);
      sourceStep = frame.step;
    }
    const x = element.rect.x + element.rect.width / 2;
    // Edge-to-edge layouts extend buttons under the system bars; aim at the part the app receives.
    const y = (Math.max(element.rect.y, device.appArea.top) + Math.min(element.rect.y + element.rect.height, device.appArea.bottom)) / 2;
    spend();
    await device.tap(x, y);
    if (locator.kind === "type" && action.text) {
      await Bun.sleep(500);
      await device.type(action.text);
      if (action.submit) await device.press("ENTER");
    }
    await Bun.sleep(POST_ACTION_MS);
    let after = await peek(device);
    if (after.contentKey === before.contentKey) {
      await Bun.sleep(SLOW_TRANSITION_MS);
      after = await peek(device);
    }
    if (after.foreground.packageName !== packageId) return { kind: "outside", packageName: after.foreground.packageName, x, y, sourceStep };
    if (after.contentKey === before.contentKey) return { kind: "no_effect" };
    const arrival = await observe();
    if (arrival.kind === "outside") return { kind: "outside", packageName: arrival.packageName, x, y, sourceStep };
    if (arrival.kind === "timeout") return { kind: "timeout" };
    return { kind: "arrived", stateId: arrival.stateId, step: arrival.step, x, y, sourceStep };
  }

  async function returnToApp(): Promise<void> {
    spend();
    await device.press("BACK");
    await Bun.sleep(POST_ACTION_MS);
    const arrival = await observe();
    if (arrival.kind === "state") return arrive(arrival.stateId, "back");
    await restart();
  }

  function arrive(stateId: string, via: "navigated" | "back" | "launch"): void {
    const index = path.indexOf(stateId);
    if (index >= 0) path = path.slice(0, index + 1);
    else if (via === "navigated") path.push(stateId);
    else path = [stateId];
    current = stateId;
  }

  async function restart(): Promise<void> {
    await device.terminate(packageId);
    await device.launch(packageId);
    await Bun.sleep(POST_ACTION_MS * 2);
    graph.app.version ??= await device.appVersion(packageId);
    const arrival = await observe();
    if (arrival.kind !== "state") throw new Error(`The app did not come back after a restart (${arrival.kind})`);
    graph.root ??= arrival.stateId;
    arrive(arrival.stateId, "launch");
    await log(`restart · at ${label(arrival.stateId)}`);
  }

  async function explore(entrance: Entrance): Promise<void> {
    const from = stateById(current!);
    const fromStep = from.steps.at(-1)!;
    await log(`  → ${entrance.locator.kind === "type" ? `type ${JSON.stringify(entrance.text)} into` : "tap"} "${entrance.name}"${entrance.submit ? " and submit" : ""} · ${entrance.reason}`);
    const result = await attempt(entrance.locator, entrance);
    if (result.kind === "moved") {
      await log("  the screen changed before acting; looking again");
      const arrival = await observe();
      if (arrival.kind === "state") arrive(arrival.stateId, arrival.stateId === from.id ? "back" : "navigated");
      else await restart();
      return;
    }
    entrance.attempts++;
    if (result.kind === "disabled" || result.kind === "timeout") {
      entrance.status = result.kind;
      await log(`  result: ${entrance.status}`);
      if (result.kind === "timeout") await restart();
      return;
    }
    // A state reached with other content (another character) no longer has the recorded element, and a tap
    // with no effect hit the wrong one: either way, let the analyst point at the element with the same intent here.
    if (result.kind === "missing" || result.kind === "no_effect") {
      const alternative = entrance.attempts <= MAX_ALTERNATIVES
        ? await analyst.alternative(graph.captures[fromStep]!, { ...entrance, kind: entrance.locator.kind }) : null;
      const element = graph.captures[fromStep]!.elements.find((item) => item.number === alternative);
      const problem = result.kind === "missing" ? "not on this page" : "no visible effect";
      if (element) {
        entrance.locator = locatorOf(graph.captures[fromStep]!, element.number);
        entrance.step = fromStep;
        entrance.name = element.name || entrance.name;
        await log(`  result: ${problem}; retrying with "${entrance.name}"`);
      } else {
        entrance.status = result.kind === "missing" ? "unreachable" : "no_effect";
        entrance.note = problem;
        await log(`  result: ${problem}`);
      }
      return;
    }
    entrance.status = "explored";
    const sourceStep = result.sourceStep;
    const edge: GraphEdge = {
      id: `e${graph.edges.length + 1}`, from: from.id, to: result.kind === "arrived" ? result.stateId : null, entrance: entrance.key,
      action: { kind: entrance.locator.kind, name: entrance.name, x: Math.round(result.x), y: Math.round(result.y), text: entrance.text, submit: entrance.submit },
      outcome: result.kind === "outside" ? "left_app" : result.stateId === from.id ? "changed_in_place" : "navigated",
      fromStep: sourceStep, toStep: result.kind === "arrived" ? result.step : null,
      change: result.kind === "arrived" ? difference(graph.captures[sourceStep]!, graph.captures[result.step]!) : { added: [], removed: [], enabled: [] },
    };
    graph.edges.push(edge);
    if (result.kind === "outside") {
      await log(`  result: left the app for ${result.packageName}; going back`);
      await returnToApp();
      return;
    }
    await log(`  result: ${edge.outcome === "navigated" ? `reached ${label(result.stateId)}` : "changed this screen in place"}` +
      `${edge.change.added.length ? ` · new: ${edge.change.added.slice(0, 4).map((name) => name.slice(0, 30)).join(", ")}` : ""}`);
    arrive(result.stateId, "navigated");
    // Typing can reveal controls, like a send button, that did not exist when the entrances were chosen. Only typing:
    // opening another article in place is new content on the same state, and following its links never ends.
    if (edge.action.kind === "type" && edge.outcome === "changed_in_place" && edge.change.added.length > 0) {
      const evidence = graph.captures[result.step]!;
      const followUps = toEntrances(evidence, await analyst.analyze(evidence, knownScreens()), from.entrances.length)
        .filter((entrance) => edge.change.added.includes(entrance.name) && !from.entrances.some((item) => item.name === entrance.name));
      from.entrances.push(...followUps);
      if (followUps.length > 0) await log(`  follow-up entrances: ${followUps.map((item) => item.name).join(" > ")}`);
    }
  }

  // Replays one recorded navigation; the recorded element may carry other content now, so the analyst can remap it.
  async function replay(edge: GraphEdge): Promise<Attempt> {
    const entrance = stateById(edge.from).entrances.find((item) => item.key === edge.entrance)!;
    await log(`  replay: ${entrance.name}`);
    const result = await attempt(entrance.locator, entrance);
    if (result.kind !== "missing" && result.kind !== "no_effect") return result;
    const evidence = graph.captures[stateById(current!).steps.at(-1)!]!;
    const alternative = await analyst.alternative(evidence, { ...entrance, kind: entrance.locator.kind });
    return alternative === null ? result : attempt(locatorOf(evidence, alternative), entrance);
  }

  // Goes to any state of a screen: Back along the path, else restart and follow recorded navigations, replanning when
  // the app takes another route. Reaching another state of the expected screen counts as staying on the route.
  async function travel(target: string): Promise<boolean> {
    const isThere = () => screenOf(current!) === target;
    await log(`travel → ${screenName(target)}`);
    while (!isThere() && path.some((id) => screenOf(id) === target)) {
      spend();
      await device.press("BACK");
      await Bun.sleep(POST_ACTION_MS);
      const arrival = await observe();
      if (arrival.kind !== "state" || !path.includes(arrival.stateId)) break;
      arrive(arrival.stateId, "back");
    }
    if (isThere()) return true;
    await restart();
    for (let plan = 0; plan <= MAX_REPLANS && !isThere(); plan++) {
      const route = routeToScreen(graph, current!, target);
      if (!route) return false;
      for (const edge of route) {
        const result = await replay(edge);
        if (result.kind === "outside") {
          await returnToApp();
          break;
        }
        if (result.kind === "moved") {
          const arrival = await observe();
          if (arrival.kind !== "state") return false;
          arrive(arrival.stateId, "navigated");
          break;
        }
        if (result.kind !== "arrived") return false;
        arrive(result.stateId, "navigated");
        if (isThere()) return true;
        if (screenOf(result.stateId) !== screenOf(edge.to!)) {
          await log(`  the app went to ${label(result.stateId)} instead; replanning`);
          break;
        }
      }
    }
    return isThere();
  }

  try {
    await log(`Exploring ${options.appKey} (${packageId}) · run ${runId} · up to ${options.maxActions} actions`);
    await restart();
    await save();
    let recoveries = 0;
    const recover = async (error: unknown, entrances: Entrance[]) => {
      if (!isDeviceTimeout(error) || ++recoveries > MAX_DEVICE_RECOVERIES) throw error;
      for (const entrance of entrances.filter((item) => item.status === "pending")) {
        entrance.status = "unreachable";
        entrance.note = "the device stopped responding";
      }
      await log(`  the device stopped responding; restarting the app (${recoveries}/${MAX_DEVICE_RECOVERIES})`);
      await restart();
    };
    for (;;) {
      const pending = stateById(current!).entrances.find((entrance) => entrance.status === "pending") ?? pendingOn(screenOf(current!));
      if (pending) {
        await explore(pending).catch((error: unknown) => recover(error, [pending]));
        await save();
        continue;
      }
      const target = [...path].reverse().map(screenOf).find((screenId) => pendingOn(screenId)) ??
        graph.states.find((state) => pendingOn(state.screenId))?.screenId;
      if (!target) {
        const isBlocked = graph.states.some((item) => item.entrances.some((entrance) => entrance.status !== "explored"));
        graph.status = isBlocked ? "blocked" : "complete";
        graph.reason = isBlocked ? "remaining entrances need a person or could not be reached" : "all entrances explored";
        break;
      }
      const onTarget = graph.states.filter((state) => state.screenId === target).flatMap((state) => state.entrances);
      const arrived = await travel(target).catch(async (error: unknown) => {
        await recover(error, onTarget);
        return false;
      });
      if (!arrived) {
        for (const entrance of onTarget) {
          if (entrance.status !== "pending") continue;
          entrance.status = "unreachable";
          entrance.note = "could not return to this screen";
        }
        await log(`  could not return to ${screenName(target)}; its entrances are unreachable`);
      }
      await save();
    }
  } catch (error) {
    if (error instanceof OutOfBudget) {
      graph.status = "incomplete";
      graph.reason = "action budget reached";
    } else {
      graph.status = "failed";
      graph.reason = error instanceof Error ? error.message : String(error);
    }
  } finally {
    const inputTokens = graph.usage.reduce((total, item) => total + item.inputTokens, 0);
    await log(`Stopped: ${graph.status} (${graph.reason}) · ${graph.states.length} states, ${graph.edges.length} edges · ` +
      `${graph.budget.used} actions · ${graph.usage.length} model calls · ${Math.round(inputTokens / 1000)}K input tokens`);
    await save();
  }
  return graph;
}
