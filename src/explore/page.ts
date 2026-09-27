import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import sharp from "sharp";

import type { AndroidDevice, Foreground, Rect } from "./device.ts";

const IGNORED_PACKAGES = /^com\.android\.systemui$|inputmethod/;
const SETTLE_MS = 3_000;
const SETTLE_INTERVAL_MS = 300;
const MAX_REVEAL_SCROLLS = 12;
const MAX_STALLS = 2;
// Scroll inside the middle of the screen, away from headers, tab bars and the system gesture area.
const SCROLL_BAND = { top: 0.15, height: 0.7 };
// An element this far down may sit under a bottom bar, so it counts as revealed only above it.
const REVEALED_BOTTOM = 0.95;
const SHORT_NAME_LENGTH = 30;
const NAME_LENGTH = 60;
const MIN_REPEATS = 3;
const NESTED_AREA_RATIO = 0.3;
const EDGE_STRIP_WIDTH = 64;
// Two reads are the same state when their action sets differ by at most this much.
const MAX_KEY_DIFFERENCE = 2;
const MAX_KEY_DIFFERENCE_RATIO = 0.1;

type Node = { className: string; attributes: Record<string, string>; rect: Rect; children: Node[] };

/** An element the explorer can act on; `onScreen` is false for page content below or above the visible area. */
export type PageElement = {
  number: number;
  kind: "tap" | "type";
  name: string;
  className: string;
  resourceId: string;
  rect: Rect;
  onScreen: boolean;
  enabled: boolean;
  repeated: boolean;
};

export type Capture = {
  step: number;
  foreground: Foreground;
  screenshot: string;
  marked: string;
  source: string;
  elementTree: string;
  elements: PageElement[];
  texts: string[];
  loading: boolean;
  settled: boolean;
  signature: string;
  actionKeys: string[];
  // Set on a frame taken after scrolling a state's page to reach an element, pointing at the frame it scrolled from.
  scroll: Scroll | null;
};

export type Scroll = { from: number; direction: "up" | "down" };

export type View = {
  foreground: Foreground; source: string; elements: PageElement[]; texts: string[]; loading: boolean; contentKey: string;
  signature: string; actionKeys: string[]; settled: boolean;
};

/** Two views show the same state when they offer the same actions, allowing a couple of content-driven differences. */
export function isSameState(a: Pick<View, "signature" | "actionKeys">, b: Pick<View, "signature" | "actionKeys">): boolean {
  if (a.signature === b.signature) return true;
  const [left, right] = [new Set(a.actionKeys), new Set(b.actionKeys)];
  const difference = [...left].filter((key) => !right.has(key)).length + [...right].filter((key) => !left.has(key)).length;
  return difference <= MAX_KEY_DIFFERENCE && difference <= MAX_KEY_DIFFERENCE_RATIO * Math.max(left.size, right.size);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (value: string) => value.replace(/&(#x?[\da-f]+|\w+);/gi, (entity, code: string) =>
  code[0] === "#" ? String.fromCodePoint(Number.parseInt(code.slice(code[1] === "x" ? 2 : 1), code[1] === "x" ? 16 : 10)) : ENTITIES[code] ?? entity);

/** Parses UiAutomator2's page source; its XML is flat attributes on nested elements, so a tag scanner suffices. */
function parseSource(xml: string): Node[] {
  const root: Node = { className: "hierarchy", attributes: {}, rect: { x: 0, y: 0, width: 0, height: 0 }, children: [] };
  const stack = [root];
  for (const [, closing, , body, selfClosing] of xml.matchAll(/<(\/)?([A-Za-z_][\w.$-]*)((?:\s+[\w:-]+="[^"]*")*)\s*(\/)?>/g)) {
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attributes = Object.fromEntries([...(body ?? "").matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key!, decode(value!)]));
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = (attributes.bounds?.match(/-?\d+/g) ?? []).map(Number);
    // Off-screen nodes report their real top edge but a bottom edge clipped to the screen.
    const node: Node = { className: attributes.class ?? "", attributes, rect: { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) }, children: [] };
    stack.at(-1)!.children.push(node);
    if (!selfClosing) stack.push(node);
  }
  // The <hierarchy> wrapper has no bounds of its own; the windows are its children.
  return root.children.flatMap((node) => node.className === "hierarchy" ? node.children : [node]);
}

const area = (rect: Rect) => rect.width * rect.height;
// React Native joins every child text into a container's content-desc, so names are capped.
const ownName = (node: Node) => (node.attributes.text || node.attributes["content-desc"] || node.attributes.hint || "").trim().slice(0, NAME_LENGTH);

// Structural shape without text or child counts, so repeated cards match even with different content.
function shape(node: Node, depth = 2): string {
  const children = [...new Set(node.children.map((child) => depth > 0 ? shape(child, depth - 1) : child.className))].sort();
  return `${node.className}(${children.join(",")})`;
}

function mergedName(node: Node): string {
  const names: string[] = [];
  const gather = (child: Node) => {
    const name = ownName(child);
    if (name && !names.includes(name)) names.push(name);
    child.children.forEach(gather);
  };
  gather(node);
  return names.slice(0, 3).join(" / ").slice(0, NAME_LENGTH);
}

/** Distills the page into actionable elements by Android accessibility flags, including content scrolled out of view. */
function readSource(xml: string, viewport: { width: number; height: number }): Omit<View, "foreground" | "source" | "settled"> {
  const elements: PageElement[] = [];
  const texts: string[] = [];
  let loading = false;
  const walk = (node: Node, outer: PageElement | null, repeated: boolean, inScroller: boolean) => {
    if (IGNORED_PACKAGES.test(node.attributes.package ?? "")) return;
    const onScreen = node.attributes.displayed === "true";
    // An invisible node is page content out of view only above or below the screen inside a scroll container.
    // Over the screen it is hidden (a closed drawer); beside it, it belongs to another page of a pager or carousel;
    // outside any scroll container (a hidden toolbar) no scrolling brings it in.
    const isBeside = node.rect.x >= viewport.width || node.rect.x + node.rect.width <= 0;
    const intersectsScreen = node.rect.x < viewport.width && node.rect.y < viewport.height &&
      node.rect.x + node.rect.width > 0 && node.rect.y + node.rect.height > 0;
    if (!onScreen && (intersectsScreen || isBeside || !inScroller)) return;
    const className = node.className.slice(node.className.lastIndexOf(".") + 1);
    if (onScreen && className.endsWith("ProgressBar")) loading = true;
    const text = node.attributes.text?.trim();
    if (text && !texts.includes(text)) texts.push(text);
    const isInput = className.endsWith("EditText");
    const isTappable = node.attributes.clickable === "true" || node.attributes.checkable === "true";
    let current = outer;
    if (isInput || isTappable) {
      // An input is named by its hint, not its typed text, so typing does not change the state.
      const name = isInput ? (node.attributes.hint ?? "").trim().slice(0, NAME_LENGTH) : ownName(node) || mergedName(node);
      const element: PageElement = {
        number: 0, kind: isInput ? "type" : "tap", name, className, resourceId: node.attributes["resource-id"] ?? "", rect: node.rect,
        onScreen, enabled: node.attributes.enabled !== "false", repeated,
      };
      const isNestedCopy = outer !== null && (!name || outer.name.includes(name)) && area(node.rect) >= area(outer.rect) * NESTED_AREA_RATIO;
      const isEdgeStrip = !name && node.rect.width <= EDGE_STRIP_WIDTH && (node.rect.x <= 0 || node.rect.x + node.rect.width >= viewport.width);
      if (!isNestedCopy && !isEdgeStrip) {
        elements.push(element);
        current = element;
      }
    }
    const shapes = node.children.map((child) => shape(child));
    node.children.forEach((child, index) => {
      const isRepeated = child.children.length > 0 && shapes.filter((other) => other === shapes[index]).length >= MIN_REPEATS;
      walk(child, current, repeated || isRepeated, inScroller || node.attributes.scrollable === "true");
    });
  };
  const roots = parseSource(xml);
  roots.forEach((root) => walk(root, null, false, false));
  elements.sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    .forEach((element, index) => { element.number = index + 1; });
  // The raw source churns with every animation, so "did anything change" compares what is visible instead.
  const visible = elements.filter((element) => element.onScreen).map((element) => [element.name, element.rect.x, element.rect.y, element.enabled]);
  const contentKey = createHash("sha1").update(JSON.stringify([visible, texts])).digest("hex");
  // State identity includes disabled and off-screen actions, independent of scroll position.
  const keys = elements.map((element) => [
    element.kind, element.className, element.resourceId,
    // Digits are masked so counters and timestamps do not split a state; inputs lose their hint once they hold text.
    element.kind === "type" || element.repeated || element.name.length > SHORT_NAME_LENGTH ? "" : element.name.replace(/[\d\s/.,:]*\d[\d\s/.,:]*/g, "#"),
  ].join("|"));
  const actionKeys = [...new Set(keys)].sort();
  return { elements, texts: texts.slice(0, 200), loading, contentKey, actionKeys, signature: createHash("sha1").update(actionKeys.join("\n")).digest("hex").slice(0, 12) };
}

/** Reads the screen until its signature repeats, within a fixed time budget; an animating screen returns unsettled. */
export async function peek(device: AndroidDevice): Promise<View> {
  const deadline = Date.now() + SETTLE_MS;
  let source = await device.source();
  let view = readSource(source, device.viewport);
  let settled = false;
  while (!settled && Date.now() < deadline) {
    await Bun.sleep(SETTLE_INTERVAL_MS);
    source = await device.source();
    const next = readSource(source, device.viewport);
    settled = next.signature === view.signature;
    view = next;
  }
  return { ...view, source, settled, foreground: await device.foreground() };
}

async function markScreenshot(screenshot: string, output: string, elements: PageElement[]): Promise<void> {
  const { width = 1080, height = 2400 } = await sharp(screenshot).metadata();
  const boxes = elements.filter((element) => element.onScreen).map((element) => {
    const { x, y, width: w, height: h } = element.rect;
    const color = element.enabled ? (element.kind === "type" ? "#2563eb" : "#e11d48") : "#6b7280";
    const labelWidth = 18 + String(element.number).length * 16;
    const labelY = Math.max(0, y - 34);
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="4"/>` +
      `<rect x="${x}" y="${labelY}" width="${labelWidth}" height="34" fill="${color}"/>` +
      `<text x="${x + 8}" y="${labelY + 26}" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#fff">${element.number}</text>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${boxes.join("")}</svg>`;
  await sharp(screenshot).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(output);
}

/** Captures the current screen as evidence: screenshot, marked screenshot, page source and actionable elements. */
export async function capture(device: AndroidDevice, options: { directory: string; projectRoot: string; step: number; scroll?: Scroll }): Promise<Capture> {
  const view = await peek(device);
  const name = (suffix: string) => join(options.directory, `${String(options.step).padStart(3, "0")}${suffix}`);
  const path = (absolute: string) => relative(options.projectRoot, absolute);
  const [screenshot, marked, source, elementTree] = [name(".png"), name("-marked.png"), name(".xml"), name(".elements.json")];
  await device.screenshot(screenshot);
  await Promise.all([
    markScreenshot(screenshot, marked, view.elements),
    writeFile(source, view.source),
    writeFile(elementTree, `${JSON.stringify(view.elements.map((element) => ({
      ref: `n${element.number}`, type: element.className, text: element.name, identifier: element.resourceId || undefined,
      coordinates: element.rect, enabled: element.enabled,
    })), null, 2)}\n`),
  ]);
  return {
    step: options.step, foreground: view.foreground, screenshot: path(screenshot), marked: path(marked), source: path(source),
    elementTree: path(elementTree), elements: view.elements, texts: view.texts, loading: view.loading, settled: view.settled,
    signature: view.signature, actionKeys: view.actionKeys, scroll: options.scroll ?? null,
  };
}

type Target = Pick<PageElement, "kind" | "className" | "resourceId" | "name" | "rect" | "onScreen">;

/** Finds a recorded element on the current page: exact kind, class, id and name, else the nearest on-screen one of the same class. */
export function locate(target: Target, elements: PageElement[]): PageElement | null {
  const distance = (element: PageElement) => Math.hypot(element.rect.x - target.rect.x, element.rect.y - target.rect.y);
  const exact = elements.filter((element) => element.kind === target.kind && element.className === target.className &&
    element.resourceId === target.resourceId && element.name === target.name);
  // A merged name can differ once a card scrolls into view and more of its children load, so a long shared prefix counts too.
  const prefix = target.name.slice(0, 24);
  const similar = prefix.length >= 12 ? elements.filter((element) => element.kind === target.kind && element.className === target.className &&
    element.name.startsWith(prefix)) : [];
  const pool = exact.length > 0 ? exact : similar.length > 0 ? similar
    : target.onScreen ? elements.filter((element) => element.onScreen && element.kind === target.kind && element.className === target.className && distance(element) < 300)
    : [];
  return pool.sort((a, b) => Number(b.onScreen) - Number(a.onScreen) || distance(a) - distance(b))[0] ?? null;
}

/** Scrolls until the target sits fully on screen, then returns it with the view it was found in; null when it never appears. */
export async function reveal(device: AndroidDevice, target: Target): Promise<{ element: PageElement; before: View; scrolled: Scroll["direction"] | null } | null> {
  const bottom = device.viewport.height * REVEALED_BOTTOM;
  const band = {
    x: 0, y: Math.round(device.viewport.height * SCROLL_BAND.top), width: device.viewport.width, height: Math.round(device.viewport.height * SCROLL_BAND.height),
  };
  let lastY: number | null = null;
  let stalls = 0;
  let scrolled: Scroll["direction"] | null = null;
  // While scrolling, one read locates the target; the settled read is taken only once it is in place.
  const settle = async () => {
    const view = await peek(device);
    const element = locate(target, view.elements);
    return element ? { element, before: view, scrolled } : null;
  };
  for (let scrolls = 0; scrolls <= MAX_REVEAL_SCROLLS && stalls < MAX_STALLS; scrolls++) {
    const element = locate(target, readSource(await device.source(), device.viewport).elements);
    if (element?.onScreen && element.rect.y >= 0 && element.rect.y + element.rect.height / 2 < bottom) return settle();
    if (!element) return null;
    // Progress is judged by the target moving: pages that load while scrolling misreport whether they can scroll further.
    stalls = element.rect.y === lastY ? stalls + 1 : 0;
    lastY = element.rect.y;
    // Only scroll toward content that exists, so a list at its top is never dragged down into pull-to-refresh.
    scrolled ??= element.rect.y < 0 ? "up" : "down";
    const canScrollMore = await device.scroll(band, scrolled);
    // A composer pinned to the bottom cannot move up; if it is visible, use it where it is.
    if (!canScrollMore && element.onScreen) return settle();
  }
  return null;
}
