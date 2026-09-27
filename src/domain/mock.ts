import type { DeviceAction } from "./observation.ts";
import type { EntranceStatus, RunStatus } from "./product-model.ts";

type Bounds = { x: number; y: number; width: number; height: number };

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
  entrances: MockEntrance[];
};

/** One entrance of a state; `step` and `bounds` place it on an observation when its element was recorded on screen. */
export type MockEntrance = {
  key: string;
  name: string;
  status: EntranceStatus;
  transitionId: string | null;
  step: number | null;
  bounds: Bounds | null;
};

export type MockTransition = {
  id: string;
  from: string;
  to: string | null;
  sourceStep: number;
  targetStep: number | null;
  action: DeviceAction;
  label: string;
  bounds: Bounds | null;
  outcome: string;
};

export type MockManifest = {
  version: 4;
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
