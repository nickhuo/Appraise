import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Agent, ModelBehaviorError, run } from "@openai/agents";
import type { AgentInputItem, Model } from "@openai/agents";
import { z } from "zod";

import type { Capture, PageElement } from "./page.ts";

const MAX_ENTRANCES = 6;
const MODEL_TIMEOUT_MS = 120_000;
const MONETIZATION_KINDS = ["paywall", "subscription", "quota", "currency", "ad", "entitlement"] as const;
const BLOCKED_REASONS = ["login", "payment", "personal_data", "media", "permission", "account_change"] as const;

export type BlockedReason = (typeof BLOCKED_REASONS)[number];
export type KnownScreen = { id: string; name: string; description: string; variants: string[] };
export type Usage = { requests: number; inputTokens: number; outputTokens: number };

const analysisSchema = z.object({
  existingScreenId: z.string().nullable(),
  screenName: z.string(),
  screenDescription: z.string(),
  variantName: z.string(),
  isLoading: z.boolean(),
  summary: z.string(),
  elementNames: z.array(z.object({ number: z.number().int(), name: z.string() })),
  monetization: z.array(z.object({ kind: z.enum(MONETIZATION_KINDS), description: z.string() })),
  entrances: z.array(z.object({
    number: z.number().int(),
    text: z.string().nullable(),
    submit: z.boolean(),
    blockedReason: z.enum(BLOCKED_REASONS).nullable(),
    reason: z.string(),
  })),
});

const alternativeSchema = z.object({ number: z.number().int().nullable(), reason: z.string() });

export type Analysis = z.infer<typeof analysisSchema>;

const INSTRUCTIONS = `You label one screen of a real Android app so an explorer can map its core experience.

You receive a screenshot with a numbered box on every visible element the explorer can act on (red: tap, blue: type, grey: disabled), and the same elements as a list. The list also includes elements further down the page, marked "below"; the explorer scrolls to them, so they are fine to choose. Code decides everything else: which state this is, when to navigate, and when to stop.

Return:
- existingScreenId: the id of a known screen when this is the same place in the app's navigation, even with different content (another character, article or message) or a different condition (signed out, quota reached, result shown). Otherwise null. A sheet, dialog or popup that covers the page so that only its own controls can be used is a screen of its own, never a variant of the page behind it, even when it is about the same topic: match it to a known sheet or dialog screen, or return null.
- screenName and screenDescription: a short snake_case name and one sentence. Reuse the known name when existingScreenId is set.
- variantName: a short snake_case label for this screen's condition, such as default, signed_out, quota_exhausted, result or empty_input. When existingScreenId is set and the condition matches one of that screen's listed variants, return that exact variant name: different content (another character, article or conversation) is the same condition. Use a new name only when what the user can do on this page differs, such as a small menu open while the page stays usable, a result being shown, or access being limited. Text typed into an input, an open keyboard, or a longer conversation is not a new condition.
- isLoading: true only if the page is still loading (skeleton placeholders, blank image areas, spinners) or an AI reply or image is still being generated (a stop or cancel generation control is shown).
- summary: one sentence about what the user sees and can do here.
- elementNames: a short name for each listed element whose name is empty, read from the screenshot (for example "back", "menu", "send", "home tab").
- monetization: every monetization mechanic visible on this screen: a paywall or plan picker, a subscription offer or badge, a usage limit or remaining count, a currency or balance, an ad, or a paid benefit. Quote the screen's exact wording, including prices, periods, counts and plan names, in the description; do not guess anything that is not shown. Empty when there is none.
- entrances: at most ${MAX_ENTRANCES} elements worth exploring for the app's core experience, most important first. The core experience is the main thing people use this app for, such as chatting with a character, generating an image, or reading an article; prefer entrances that start or advance such a task and put the next step of the task the user is in the middle of first. Skip pagination, sorting, filters, comments, likes, favorites, sharing and settings unless they reveal a paywall, usage limit, currency, subscription or ad. A disabled element may be listed after the step that enables it, such as a send button after typing. For type entrances, give short harmless ASCII sample text (at most 60 characters, no personal data) and set submit only when Enter submits the field, as in a search box. Set blockedReason when the entrance needs a human or must not be exercised: login (an account or credentials), payment, personal_data, media (a photo or the camera), permission (a system permission), account_change (it would change the signed-in account: profile, bio, avatar, settings, follows, favorites, reports or blocks). Never choose purchases, public posting, sending email or logging out. The system Back is always available; do not list it.`;

function elementLine(element: PageElement): string {
  const flags = [element.enabled ? "" : " disabled", element.onScreen ? "" : " below"].join("");
  const id = element.resourceId ? ` id=${element.resourceId.slice(element.resourceId.indexOf("/") + 1)}` : "";
  return `${element.number} ${element.kind} ${JSON.stringify(element.name.slice(0, 80))} ${element.className}${id}${flags}`;
}

const TEMPLATE_SAMPLES = 3;

/** Elements shown to the model: repeated ones (feed cards, tags) are grouped by class and height, keeping a few of each. */
export function modelElements(capture: Capture): PageElement[] {
  const seen = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const element of capture.elements) counts.set(element.name, (counts.get(element.name) ?? 0) + 1);
  return capture.elements.filter((element) => {
    // A short name found once on the page is a control such as "Chat with Jay", even inside repeated structure.
    const isUniqueControl = element.name.length > 0 && element.name.length <= 30 && counts.get(element.name) === 1;
    if (!element.repeated || isUniqueControl) return true;
    const template = `${element.className}|${Math.round(element.rect.height / 16)}`;
    seen.set(template, (seen.get(template) ?? 0) + 1);
    return seen.get(template)! <= TEMPLATE_SAMPLES;
  });
}

export class Analyst {
  readonly usage: Usage[] = [];
  private readonly analysisAgent: Agent<unknown, typeof analysisSchema>;
  private readonly alternativeAgent: Agent<unknown, typeof alternativeSchema>;

  constructor(model: string | Model, private readonly appName: string, private readonly projectRoot: string) {
    this.analysisAgent = new Agent({ name: "Screen analyst", model, instructions: INSTRUCTIONS, outputType: analysisSchema });
    this.alternativeAgent = new Agent({ name: "Screen analyst", model, instructions: INSTRUCTIONS, outputType: alternativeSchema });
  }

  async analyze(capture: Capture, screens: KnownScreen[]): Promise<Analysis> {
    const elements = modelElements(capture);
    const known = screens.map((screen) => `${screen.id}: ${screen.name} (${screen.variants.join(", ")}) — ${screen.description}`);
    const text = [
      `App: ${this.appName}. Activity: ${capture.foreground.activity}.`,
      `Known screens:\n${known.join("\n") || "none yet"}`,
      `Elements:\n${elements.map(elementLine).join("\n")}`,
    ].join("\n\n");
    const analysis = await this.ask(this.analysisAgent, text, capture);
    const numbers = new Set(elements.map((element) => element.number));
    return {
      ...analysis,
      existingScreenId: screens.some((screen) => screen.id === analysis.existingScreenId) ? analysis.existingScreenId : null,
      entrances: analysis.entrances.filter((entrance) => numbers.has(entrance.number)).slice(0, MAX_ENTRANCES),
    };
  }

  /** Asks for the element with the same intent after an entrance had no visible effect or is not on this page. */
  async alternative(capture: Capture, entrance: { name: string; reason: string; kind: PageElement["kind"] }): Promise<number | null> {
    const elements = modelElements(capture).filter((element) => element.kind === entrance.kind);
    const text = `App: ${this.appName}. The entrance "${entrance.name}" (${entrance.reason}) was planned on this kind of screen, ` +
      `but it had no effect or is not on this page, which may show other content. ` +
      `Pick the listed element that achieves the same intent here, or null if none does.\n\nElements:\n${elements.map(elementLine).join("\n")}`;
    const answer = await this.ask(this.alternativeAgent, text, capture);
    return elements.some((element) => element.number === answer.number) ? answer.number : null;
  }

  // Sends the text with the capture's marked screenshot.
  private async ask<T extends z.ZodTypeAny>(agent: Agent<unknown, T>, text: string, capture: Capture): Promise<z.infer<T>> {
    const image = `data:image/png;base64,${(await readFile(join(this.projectRoot, capture.marked))).toString("base64")}`;
    const input: AgentInputItem[] = [{ role: "user", content: [
      { type: "input_text", text },
      { type: "input_image", image, detail: "high" },
    ] }];
    // Strict structured output makes a schema violation rare; one retry covers a malformed or stalled reply.
    for (let attempt = 0; ; attempt++) {
      try {
        const outcome = await run(agent, input, { maxTurns: 1, signal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
        const { requests, inputTokens, outputTokens } = outcome.runContext.usage;
        this.usage.push({ requests, inputTokens, outputTokens });
        if (!outcome.finalOutput) throw new Error("Screen analyst returned no output");
        return outcome.finalOutput as z.infer<T>;
      } catch (error) {
        const isRetryable = error instanceof ModelBehaviorError || (error instanceof Error && error.name === "TimeoutError");
        if (!isRetryable || attempt > 0) throw error;
      }
    }
  }
}
