export type ScreenElement = {
  ref: string;
  type: string;
  text?: string;
  label?: string;
  name?: string;
  value?: string;
  identifier?: string;
  coordinates: { x: number; y: number; width: number; height: number };
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;
  enabled?: boolean;
};

export type DeviceAction = {
  // A back with targetRef taps that in-app return control; without one it presses Android Back.
  type: "tap" | "type" | "swipe" | "back" | "wait";
  targetRef: string | null;
  x: number | null;
  y: number | null;
  text: string | null;
  submit: boolean;
  direction: "up" | "down" | "left" | "right" | "none";
  reason: string;
  groupKey?: string;
};

export type MonetizationFact = {
  kind: "paywall" | "subscription" | "quota" | "currency" | "ad" | "entitlement";
  description: string;
  basis: "observed" | "inferred";
};

export type Visual = {
  layout: string;
  colors: string[];
  typography: string;
  copy: string[];
  assets: Array<{ description: string; bounds: number[] }>;
};

export type ActionGroup = {
  key: string;
  description: string;
  memberRefs: string[];
  isCore: boolean;
  journeyRole?: "entry" | "required_step" | "supporting";
};

export type Boundary = {
  kind: "camera" | "photo_library" | "os_settings" | "permission" | "external_browser" | "external_app";
  required: boolean;
  reason: string;
};
