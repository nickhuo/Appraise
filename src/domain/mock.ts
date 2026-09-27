import type { DeviceAction } from "./observation.ts";
import type { RunStatus } from "./product-model.ts";

export type MockObservation = {
  step: number;
  stateId: string;
  viewport: { width: number; height: number };
  evidence: { screenshot: string; elementTree: string };
  scroll?: { from: number; direction: "up" | "down" };
};

export type MockState = {
  id: string;
  screen: string;
  variant: string;
  summary: string;
  observationSteps: number[];
  unexploredGroups: string[];
};

export type MockTransition = {
  id: string;
  from: string;
  to: string | null;
  sourceStep: number;
  targetStep: number | null;
  action: DeviceAction;
  label: string;
  bounds: { x: number; y: number; width: number; height: number } | null;
  outcome: string;
};

export type MockManifest = {
  version: 3;
  runId: string;
  inputHash: string;
  app: string;
  runStatus: RunStatus;
  stopReason: string;
  initialStep: number;
  states: MockState[];
  observations: MockObservation[];
  transitions: MockTransition[];
};

export type MockPreview = {
  manifest: MockManifest;
  images: Record<string, string>;
};
