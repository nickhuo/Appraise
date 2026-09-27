import type { MonetizationFact } from "../domain/observation.ts";
import type { EntranceStatus, ProductModel, RunStatus } from "../domain/product-model.ts";
import { validateSnapshot } from "../domain/product-model.ts";
import { type Analysis, type BlockedReason, modelElements, type Usage } from "./analyst.ts";
import type { Capture, PageElement } from "./page.ts";

const PAYMENT = /confirm purchase|buy now|pay now|place order|subscribe now/i;
// Exploration must never change the signed-in account, report anyone, or end the session.
const ACCOUNT_CHANGE = /edit profile|save changes|log ?out|sign ?out|delete|change password|post publicly|send email|report|block|follow|favou?rite/i;

export type Locator = Pick<PageElement, "kind" | "className" | "resourceId" | "name" | "rect" | "onScreen">;

export type Entrance = {
  key: string;
  name: string;
  reason: string;
  locator: Locator;
  // The observation the locator was read from.
  step: number;
  text: string | null;
  submit: boolean;
  blockedReason: BlockedReason | null;
  status: EntranceStatus;
  note: string | null;
  attempts: number;
};

export type GraphState = {
  id: string;
  screenId: string;
  variant: string;
  summary: string;
  activity: string;
  signature: string;
  actionKeys: string[];
  steps: number[];
  elements: PageElement[];
  entrances: Entrance[];
  // Facts seen on any capture the analyst read for this state; different content can show different ones.
  monetization: Array<MonetizationFact & { step: number }>;
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string | null;
  entrance: string;
  action: { kind: PageElement["kind"]; name: string; x: number; y: number; text: string | null; submit: boolean };
  outcome: "navigated" | "changed_in_place" | "left_app";
  fromStep: number;
  toStep: number | null;
  change: { added: string[]; removed: string[]; enabled: string[] };
};

export type Graph = {
  runId: string;
  app: { key: string; packageId: string; version: string | null };
  status: RunStatus | "running";
  reason: string;
  startedAt: string;
  viewport: { width: number; height: number };
  root: string | null;
  budget: { used: number; max: number };
  screens: Array<{ id: string; name: string; description: string }>;
  states: GraphState[];
  edges: GraphEdge[];
  captures: Record<string, Capture>;
  usage: Usage[];
};

/** The analysis's monetization facts that the state does not already record. */
export function newMonetization(state: Pick<GraphState, "monetization">, analysis: Analysis, step: number): GraphState["monetization"] {
  const known = new Set(state.monetization.map((fact) => fact.description));
  return analysis.monetization.filter((fact) => !known.has(fact.description)).map((fact) => ({ ...fact, basis: "observed" as const, step }));
}

export function namedElements(evidence: Capture, analysis: Analysis): PageElement[] {
  const names = new Map(analysis.elementNames.map((item) => [item.number, item.name]));
  return evidence.elements.map((element) => ({ ...element, name: element.name || names.get(element.number) || "" }));
}

// The locator keeps the accessibility name so the element can be found again; the display name may come from the analyst.
export function toEntrances(evidence: Capture, analysis: Analysis, offset: number): Entrance[] {
  const elements = namedElements(evidence, analysis);
  return analysis.entrances.map((entrance, index) => {
    const name = elements.find((item) => item.number === entrance.number)!.name || `element ${entrance.number}`;
    const blockedReason = entrance.blockedReason ?? (PAYMENT.test(name) ? "payment" : ACCOUNT_CHANGE.test(name) ? "account_change" : null);
    return {
      key: `${offset + index + 1}_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32) || "element"}`,
      name, reason: entrance.reason, text: entrance.text, submit: entrance.submit, blockedReason,
      locator: locatorOf(evidence, entrance.number), step: evidence.step,
      status: blockedReason ? "blocked" : "pending", note: blockedReason, attempts: 0,
    };
  });
}

export function locatorOf(evidence: Capture, number: number): Locator {
  const { kind, className, resourceId, name, rect, onScreen } = evidence.elements.find((item) => item.number === number)!;
  return { kind, className, resourceId, name, rect, onScreen };
}

export function difference(before: Capture, after: Capture): GraphEdge["change"] {
  const names = (capture: Capture) => new Set(modelElements(capture).map((element) => element.name).filter(Boolean));
  const [was, now] = [names(before), names(after)];
  const disabledBefore = new Set(before.elements.filter((element) => !element.enabled).map((element) => element.name));
  return {
    added: [...now].filter((name) => !was.has(name)),
    removed: [...was].filter((name) => !now.has(name)),
    enabled: after.elements.filter((element) => element.enabled && disabledBefore.has(element.name)).map((element) => element.name),
  };
}

/** The fewest recorded navigations from a state to any state of a screen; null when no recorded path exists. */
export function routeToScreen(graph: Graph, from: string, screenId: string): GraphEdge[] | null {
  const screenOf = (id: string) => graph.states.find((state) => state.id === id)!.screenId;
  if (screenOf(from) === screenId) return [];
  const previous = new Map<string, GraphEdge>();
  const queue = [from];
  for (let index = 0; index < queue.length; index++) {
    for (const edge of graph.edges.filter((item) => item.outcome === "navigated" && item.from === queue[index])) {
      if (edge.to === null || edge.to === from || previous.has(edge.to)) continue;
      previous.set(edge.to, edge);
      if (screenOf(edge.to) === screenId) {
        const route: GraphEdge[] = [];
        for (let node = edge.to; node !== from; node = previous.get(node)!.from) route.unshift(previous.get(node)!);
        return route;
      }
      queue.push(edge.to);
    }
  }
  return null;
}

/** Exports the graph in the ProductModel shape that recreate, recommend and present already read. */
export function toProductModel(graph: Graph): ProductModel {
  const evidence = (step: number) => {
    const evidence = graph.captures[step]!;
    return { step, screenshot: evidence.screenshot, elementTree: evidence.elementTree, ...evidence.scroll && { scroll: evidence.scroll } };
  };
  const model: ProductModel = {
    runId: graph.runId,
    runStatus: graph.status === "running" ? "incomplete" : graph.status,
    stopReason: graph.reason || "running",
    app: graph.app,
    frontier: {
      pending: graph.states.flatMap((state) => state.entrances).filter((entrance) => entrance.status === "pending").length,
      blocked: graph.states.flatMap((state) => state.entrances).filter((entrance) => !["pending", "explored"].includes(entrance.status)).length,
    },
    states: graph.states.map((state) => {
      const first = graph.captures[state.steps[0]!]!;
      const screen = graph.screens.find((screen) => screen.id === state.screenId)!.name;
      return {
        id: state.id, screen, variant: state.variant, summary: state.summary, isCore: true, isModal: false,
        viewport: graph.viewport,
        visual: { copy: first.texts.slice(0, 40) },
        groups: state.entrances.map((entrance) => ({
          key: entrance.key, description: entrance.name, isCore: true, explored: entrance.status === "explored",
          coverage: entrance.status === "pending" ? "pending" as const : entrance.status === "explored" ? "explored" as const : "blocked" as const,
          blockReason: ["pending", "explored"].includes(entrance.status) ? undefined : entrance.note ?? entrance.status,
          status: entrance.status,
          location: { step: entrance.step, bounds: entrance.locator.rect, onScreen: entrance.locator.onScreen },
        })),
        evidence: state.steps.map(evidence),
        monetization: state.monetization.map(({ kind, description, basis }, index) => ({ id: `${state.id}-m${index + 1}`, kind, description, basis })),
      };
    }),
    transitions: graph.edges.map((edge) => ({
      id: edge.id, from: edge.from, to: edge.to, destinationStep: edge.toStep ?? undefined,
      action: {
        type: edge.action.kind, targetRef: null, x: edge.action.x, y: edge.action.y, text: edge.action.text, submit: edge.action.submit,
        direction: "none" as const, reason: edge.action.name, groupKey: edge.entrance,
      },
      outcome: edge.outcome, changeSummary: [edge.change.added.length ? `added ${edge.change.added.join(", ")}` : "",
        edge.change.enabled.length ? `enabled ${edge.change.enabled.join(", ")}` : ""].filter(Boolean).join("; ") || null,
      evidence: evidence(edge.fromStep),
    })),
  };
  validateSnapshot(model);
  return model;
}
