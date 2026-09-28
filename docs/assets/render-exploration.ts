import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const WIDTH = 1280;
const HEIGHT = 800;
const SCENE_MS = 3_750;
const FRAME_MS = 90;
const COLORS = { ink: "#18332f", muted: "#64756e", paper: "#f5f4ee", line: "#d8dfd7", green: "#187d69", purple: "#7156b8" };
const NODES = [
  { id: "A", label: "Home", path: "A", x: 820, y: 230 },
  { id: "B", label: "Character detail", path: "A  >  B", x: 660, y: 330 },
  { id: "C", label: "Chat", path: "A  >  B  >  C", x: 555, y: 440 },
  { id: "D", label: "Voice preview", path: "A  >  B  >  D", x: 795, y: 440 },
  { id: "E", label: "Image creator", path: "A  >  E", x: 1060, y: 330 },
];
const EDGES = [[0, 1], [1, 2], [1, 3], [0, 4]] as const;

type Scene = {
  title: string;
  owner: "AGENT" | "CODE";
  node: number;
  known: boolean;
  phone: "home" | "detail" | "chat" | "voice" | "image";
  panel: string;
  lines: string[];
  caption: string;
  discovered: number;
  move?: number[];
};

const SCENES: Scene[] = [
  {
    title: "Choose the core actions", owner: "AGENT", node: 0, known: false, phone: "home", discovered: 0,
    panel: "New State A / Home", lines: ["1. Discover characters", "2. Create an image", "Skip Settings for this journey."],
    caption: "Input: screenshot + controls + known Screens / Variants. Select and prioritize core entrances.",
  },
  {
    title: "Follow the first branch", owner: "AGENT", node: 1, known: false, phone: "detail", discovered: 1, move: [0, 1],
    panel: "New State B / Character detail", lines: ["1. Start chat", "2. Voice preview", "Continue here before returning to Home."],
    caption: "Code opens B; the agent identifies the new State and selects its core entrances.",
  },
  {
    title: "Scroll to the chosen control", owner: "CODE", node: 1, known: true, phone: "detail", discovered: 1,
    panel: "Appium reveals the target", lines: ["Start chat is below the viewport.", "Scroll to it, then tap.", "Keep the actual tap frame as evidence."],
    caption: "Appium can expose offscreen controls. This scroll stays within State B.",
  },
  {
    title: "Go deeper: start chatting", owner: "CODE", node: 2, known: false, phone: "chat", discovered: 2, move: [1, 2],
    panel: "A > B > C", lines: ["Open Chat and follow its core actions.", "Observe what each action changes.", "Finish this branch's pending work."],
    caption: "Depth-first exploration: continue along the current journey before trying another branch.",
  },
  {
    title: "Return and resume pending work", owner: "CODE", node: 1, known: true, phone: "detail", discovered: 2, move: [2, 1],
    panel: "Known State B / reuse its entrances", lines: ["Start chat       /   explored", "Voice preview /   pending", "Next: Voice preview."],
    caption: "Code recognizes B and resumes its pending entrances without asking the agent to select again.",
  },
  {
    title: "Explore the next branch", owner: "CODE", node: 3, known: false, phone: "voice", discovered: 3, move: [1, 3],
    panel: "A > B > D", lines: ["Open Voice preview.", "Explore its core actions.", "B's two branches are now finished."],
    caption: "Completed entrances stay completed when the explorer returns to a known State.",
  },
  {
    title: "Pop back to unfinished work", owner: "CODE", node: 0, known: true, phone: "home", discovered: 3, move: [3, 1, 0],
    panel: "D > B > A", lines: ["B has no pending entrances left.", "Home still has Create an image.", "Resume that remaining entrance."],
    caption: "The navigation path acts as a stack: backtrack to the nearest screen with pending work.",
  },
  {
    title: "Finish the remaining journey", owner: "CODE", node: 4, known: false, phone: "image", discovered: 4, move: [0, 4],
    panel: "A > E / Image creator", lines: ["Explore the remaining core actions.", "Save States, actions and evidence.", "Stop when discovered work is done."],
    caption: "Budgets or blockers can stop a run earlier. Complete does not mean full-app coverage.",
  },
];

function text(x: number, y: number, value: string, size = 20, color = COLORS.ink, weight = 400): string {
  const escaped = value.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${size}" fill="${color}" font-weight="${weight}">${escaped}</text>`;
}

function box(x: number, y: number, width: number, height: number, fill: string, stroke = fill, radius = 14): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}"/>`;
}

function phone(scene: Scene, index: number, progress: number): string {
  let content = box(68, 178, 306, 492, "#ffffff", COLORS.line, 30);
  content += box(174, 193, 94, 6, "#c5cec7", "#c5cec7", 3);
  content += text(91, 241, NODES[scene.node]!.label, 24, COLORS.ink, 700);
  content += text(91, 273, "Illustrative app screen", 15, COLORS.muted);
  let controls = "";
  if (scene.phone === "home") {
    for (const [i, label] of ["Discover characters", "Create an image", "Settings"].entries()) {
      const y = 316 + i * 80;
      controls += box(88, y, 266, 60, i === 2 ? "#f3f3ef" : "#e9f4ed", i === 2 ? COLORS.line : "#9dc8b4");
      controls += text(100, y + 36, `${i + 1}   ${label}`, 18, i === 2 ? COLORS.muted : COLORS.ink);
    }
    if (index === 0) controls += text(100, 591, "Core actions: 1 and 2", 18, COLORS.purple, 700);
  } else if (scene.phone === "detail") {
    const offset = index === 2 ? progress * 218 : index === 4 ? 218 : 0;
    controls += `<g clip-path="url(#phone-clip)"><g transform="translate(0,${-offset})">`;
    controls += box(88, 304, 266, 136, "#e9e5f3");
    controls += `<circle cx="221" cy="355" r="28" fill="#ac9acf"/>`;
    controls += text(180, 413, "Meet Alex", 20, COLORS.purple, 700);
    controls += text(100, 480, "A friendly conversation partner", 15, COLORS.muted);
    controls += text(100, 515, "About this character", 18);
    controls += text(100, 549, "Interests, stories and ideas...", 16, COLORS.muted);
    for (const [i, label] of ["Start chat", "Voice preview"].entries()) {
      const y = 638 + i * 78;
      controls += box(88, y, 266, 60, "#e9f4ed", "#65ad91");
      controls += text(104, y + 36, `${i + 1}   ${label}`, 20);
    }
    controls += "</g></g>";
    if (index === 2) content += text(92, 699, "Same State B / new frame", 17, COLORS.green, 700);
  } else if (scene.phone === "chat") {
    controls += box(88, 311, 230, 73, "#ede8f6");
    controls += text(103, 354, "Hi! What is on your mind?", 16);
    if (index === 3) {
      controls += box(118, 405, 236, 65, "#e4f1e9");
      controls += text(134, 444, "Tell me a short story.", 17);
      controls += box(88, 491, 237, 65, "#ede8f6");
      controls += text(103, 530, "Once upon a time...", 17);
    }
    controls += box(88, 590, 266, 53, "#f5f6f2", COLORS.line);
    controls += text(103, 623, "Message Alex...", 17, COLORS.muted);
  } else {
    controls += box(88, 317, 266, 177, scene.phone === "voice" ? "#e9e5f3" : "#e4f1e9");
    controls += text(115, 410, scene.phone === "voice" ? "Listen to a preview" : "Describe your image", 20);
    controls += box(88, 527, 266, 63, "#e9f4ed", "#9dc8b4");
    controls += text(112, 565, scene.phone === "voice" ? "Play sample" : "Create image", 20);
  }
  return content + controls;
}

const directory = fileURLToPath(new URL("./", import.meta.url));
await mkdir(directory, { recursive: true });
const frames: Buffer[] = [];
const delays: number[] = [];
for (const [index, scene] of SCENES.entries()) {
  const count = scene.move || index === 2 ? 9 : 1;
  for (let frame = 0; frame < count; frame++) {
    const progress = count === 1 ? 1 : frame / (count - 1);
    const accent = scene.owner === "AGENT" ? COLORS.purple : COLORS.green;
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"><defs><clipPath id="phone-clip"><rect x="82" y="292" width="278" height="355" rx="10"/></clipPath></defs>`;
    svg += box(0, 0, WIDTH, HEIGHT, COLORS.paper, COLORS.paper, 0);
    svg += text(48, 43, "APPRAISE  /  EXPLORE A CORE USER JOURNEY", 17, COLORS.muted, 700);
    svg += text(48, 94, scene.title, 32, COLORS.ink, 700);
    svg += box(48, 116, 90, 30, accent, accent, 8) + text(64, 137, scene.owner, 14, "#ffffff", 700);
    svg += text(152, 138, `${String(index + 1).padStart(2, "0")} / ${SCENES.length}     ${scene.known ? "KNOWN STATE" : "OBSERVE / IDENTIFY"}`, 16, COLORS.muted);
    svg += phone(scene, index, progress);
    svg += text(435, 192, "OBSERVED JOURNEY", 15, COLORS.muted, 700);
    svg += text(990, 192, "A - E = example States", 15, COLORS.muted);
    for (const [edgeIndex, [from, to]] of EDGES.entries()) {
      const a = NODES[from]!;
      const b = NODES[to]!;
      const observed = edgeIndex < scene.discovered;
      svg += `<path d="M${a.x} ${a.y + 23} L${b.x} ${b.y - 23}" stroke="${observed ? "#74ad98" : COLORS.line}" stroke-width="3" fill="none" ${observed ? "" : 'stroke-dasharray="5 6"'}/>`;
    }
    for (const [nodeIndex, node] of NODES.entries()) {
      const active = nodeIndex === scene.node;
      const discovered = nodeIndex <= scene.discovered;
      svg += box(node.x - 89, node.y - 25, 178, 50, active ? accent : discovered ? "#ffffff" : "#eeefe9", active ? accent : COLORS.line, 12);
      svg += text(node.x - 76, node.y + 6, `${node.id}  ${node.label}`, 17, active ? "#ffffff" : discovered ? COLORS.ink : "#8c9891", active ? 700 : 400);
    }
    if (scene.move && progress < 1) {
      const position = progress * (scene.move.length - 1);
      const segment = Math.floor(position);
      const a = NODES[scene.move[segment]!]!;
      const b = NODES[scene.move[segment + 1]!]!;
      const x = a.x + (b.x - a.x) * (position - segment);
      const y = a.y + (b.y - a.y) * (position - segment);
      svg += `<circle cx="${x}" cy="${y}" r="8" fill="${accent}" stroke="white" stroke-width="3"/>`;
    }
    svg += text(435, 485, `PATH STACK   ${NODES[scene.node]!.path}`, 16, COLORS.green, 700);
    svg += box(432, 496, 795, 184, "#ffffff", COLORS.line);
    svg += text(458, 532, scene.panel, 23, accent, 700);
    for (const [lineIndex, line] of scene.lines.entries()) svg += text(458, 573 + lineIndex * 33, line, 21);
    svg += text(48, 741, scene.caption, 20, COLORS.ink);
    for (let dot = 0; dot < SCENES.length; dot++) svg += box(48 + dot * 148, 771, 137, 5, dot <= index ? accent : COLORS.line, "none", 2);
    svg += "</svg>";
    const rendered = sharp(Buffer.from(svg));
    frames.push(await rendered.clone().ensureAlpha().raw().toBuffer());
    delays.push(frame === count - 1 ? SCENE_MS - (count - 1) * FRAME_MS : FRAME_MS);
    if (index === 2 && frame === count - 1) {
      await rendered.png().toFile(fileURLToPath(new URL("exploration-flow.png", import.meta.url)));
    }
  }
}
const output = new URL("exploration-flow.gif", import.meta.url);
await sharp(Buffer.concat(frames), { raw: { width: WIDTH, height: HEIGHT * frames.length, channels: 4, pageHeight: HEIGHT } })
  .gif({ loop: 0, delay: delays, colours: 128, dither: 0 }).toFile(fileURLToPath(output));
console.log(`Rendered ${frames.length} frames, ${delays.reduce((sum, delay) => sum + delay, 0) / 1000}s: ${output.pathname}`);
