import type { DeviceAction, MonetizationFact } from "./observation.ts";

/**
 * Why an exploration run stopped; `stopReason` carries the specific cause.
 * - complete: every discovered core entrance group was explored, with none blocked.
 * - incomplete: a limit or navigation failure left groups pending.
 * - blocked: human input, the app, device, or environment prevented progress.
 * - failed: our side threw an error; the snapshot is only what was recorded before the crash.
 */
export type RunStatus = "complete" | "incomplete" | "blocked" | "failed";

/** What happened to an entrance: executed, still queued, or why it could not be. */
export type EntranceStatus = "pending" | "explored" | "blocked" | "no_effect" | "unreachable" | "timeout" | "disabled";

type Evidence = {
  step: number;
  screenshot: string;
  elementTree: string;
  // A frame of the same page after scrolling from another observation to reach an element.
  scroll?: { from: number; direction: "up" | "down" };
};

export type ProductModel = {
  runId: string;
  runStatus: RunStatus;
  stopReason: string;
  app: { key: string; packageId: string; version: string | null };
  frontier?: { pending: number; blocked: number };
  barriers?: Array<{ stateId: string; groupKey: string | null; reason: string; evidence: Evidence }>;
  states: Array<{
    id: string;
    screen: string;
    variant: string;
    summary: string;
    isCore: boolean;
    isModal: boolean;
    viewport: { width: number; height: number };
    visual: { copy: string[] };
    groups: Array<{
      key: string;
      description: string;
      isCore: boolean;
      explored: boolean;
      coverage?: "pending" | "explored" | "blocked" | "covered" | "skipped" | "deferred";
      coveredBy?: string | null;
      blockReason?: string | null;
      status?: EntranceStatus;
      location?: { step: number; bounds: { x: number; y: number; width: number; height: number }; onScreen: boolean };
    }>;
    evidence: Evidence[];
    monetization: Array<MonetizationFact & { id: string }>;
  }>;
  transitions: Array<{
    id: string;
    from: string;
    to: string | null;
    destinationStep?: number;
    action: DeviceAction;
    outcome: string;
    changeSummary: string | null;
    evidence: Evidence;
  }>;
};

export function validateSnapshot(snapshot: ProductModel): void {
  const stateIds = new Set(snapshot.states.map((state) => state.id));
  const transitionIds = new Set(snapshot.transitions.map((transition) => transition.id));
  const runDirectory = `runs/${snapshot.app.key}/${snapshot.runId}/`;
  if (stateIds.size !== snapshot.states.length || transitionIds.size !== snapshot.transitions.length) {
    throw new Error("Product model contains duplicate state or transition IDs");
  }
  const observedSteps = new Set<number>();
  for (const state of snapshot.states) {
    if (state.evidence.length === 0) throw new Error(`State ${state.id} has no observation`);
    for (const group of state.groups) {
      if (group.coverage === "covered" && (!group.coveredBy || !transitionIds.has(group.coveredBy))) {
        throw new Error(`State ${state.id} has a group without a covering transition`);
      }
    }
    for (const observation of state.evidence) {
      if (!Number.isInteger(observation.step) || observation.step < 0 ||
          !observation.screenshot.startsWith(runDirectory) ||
          !observation.elementTree.startsWith(runDirectory) ||
          [observation.screenshot, observation.elementTree].some((path) => path.split("/").includes(".."))) {
        throw new Error(`State ${state.id} has invalid evidence`);
      }
      observedSteps.add(observation.step);
    }
  }
  for (const transition of snapshot.transitions) {
    if (!stateIds.has(transition.from) || (transition.to !== null && !stateIds.has(transition.to)) ||
        !observedSteps.has(transition.evidence.step)) {
      throw new Error(`Transition ${transition.id} has an invalid state or observation reference`);
    }
    if (transition.destinationStep !== undefined && !snapshot.states.find((state) => state.id === transition.to)
      ?.evidence.some((evidence) => evidence.step === transition.destinationStep)) {
      throw new Error(`Transition ${transition.id} has an invalid destination observation`);
    }
  }
  for (const barrier of snapshot.barriers ?? []) {
    const state = snapshot.states.find((item) => item.id === barrier.stateId);
    if (!state?.evidence.some((evidence) => evidence.step === barrier.evidence.step &&
      evidence.screenshot === barrier.evidence.screenshot && evidence.elementTree === barrier.evidence.elementTree)) {
      throw new Error("Product model contains a barrier without supporting evidence");
    }
  }
}
