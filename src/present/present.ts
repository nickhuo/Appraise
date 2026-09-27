import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { MockManifest } from "../domain/mock.ts";
import type { ProductModel } from "../domain/product-model.ts";
import { validateSnapshot } from "../domain/product-model.ts";
import type { Judgment, Proposal } from "../domain/proposal.ts";

type Concept = {
  proposal: Proposal;
  observedScreen: string;
  observedSummary: string;
  evidenceId: string;
  evidencePath: string | null;
  screenshot: string | null;
  resume: { stateId: string; screen: string; screenshot: string | null };
};

const demoProposal: Proposal = {
  id: "demo-refill",
  revision: 0,
  title: "Extra conversation time when it matters",
  opportunityType: "product_change",
  entryStateId: "demo-chat-limit",
  evidenceIds: ["demo-chat-limit"],
  trigger: "A user reaches a conversation limit during an active task.",
  userNeed: "Finish the conversation without losing context.",
  eligibility: "Free users at the limit",
  productChange: "Offer one extra conversation turn at the existing limit.",
  reward: "One extra conversation turn",
  optIn: "Watch a short ad to continue",
  fulfillment: "Add the turn after the ad completes, then return to the same chat.",
  declinePath: "Close the offer and keep the existing limit screen available.",
  failurePath: "Return to the limit screen without granting a turn.",
  businessImpact: "Test whether occasional extra turns reduce frustration without replacing subscriptions.",
  validationPlan: "Measure offer acceptance, turn usage, return to chat, and subscription conversion.",
  assumptions: ["The conversation limit and reward size are illustrative demo data."],
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function preview(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const sentence = normalized.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? normalized;
  if (sentence.length <= limit) return sentence;
  const clipped = sentence.slice(0, limit + 1);
  return `${clipped.slice(0, clipped.lastIndexOf(" ") > 0 ? clipped.lastIndexOf(" ") : limit).trimEnd()}…`;
}

type Overlay = "none" | "banner" | "sheet" | "full" | "toast";

function phone(label: string, isProposed: boolean, screen: string): string {
  return `<figure class="phone-wrap"><figcaption class="phone-label">${escapeHtml(label)}<span class="phone-tag${isProposed ? " proposed" : ""}">${isProposed ? "Proposed" : "Observed"}</span></figcaption><div class="phone">${screen}</div></figure>`;
}

function conceptSlides(concept: Concept, appName: string, isDemo: boolean): string[] {
  const { proposal, observedScreen, observedSummary, evidenceId, screenshot, resume } = concept;
  const reward = preview(proposal.reward.split(/[,;.—]|\s(?:after|before|when|once|not)\s|\b(?:applied|credited|delivered|granted)\b/i)[0]!.trim()
    .replace(/^One additional /i, "One extra "), 72);
  const title = preview(proposal.title.split(",")[0]!, 100);
  const validation = proposal.assumptions.slice(0, 2)
    .map((assumption) => preview(assumption
      .replace(/\s*\((?:state|evidence|coverage)[^)]*\)/gi, "")
      .replace(/\s+in state [0-9a-f-]+/gi, ""), 145))
    .join(" ") || preview(proposal.validationPlan, 170);
  const prefix = isDemo ? "Illustrative demo" : `Proposal ${escapeHtml(proposal.id)} · revision ${escapeHtml(String(proposal.revision))}`;
  const source = isDemo ? "Demo data" : `Observed screen: ${escapeHtml(observedScreen)} · evidence: ${escapeHtml(evidenceId)}` +
    (resume.stateId !== evidenceId ? ` · resumes on ${escapeHtml(resume.screen)} (${escapeHtml(resume.stateId)})` : "");
  const appHeader = `<div class="app-head"><span class="app-mark">${escapeHtml(appName.slice(0, 1).toUpperCase())}</span><strong>${escapeHtml(appName)}</strong></div>`;
  const button = (copy: string, secondary = false): string => `<div class="mock-button${secondary ? " secondary" : ""}">${escapeHtml(copy)}</div>`;
  // Proposed UI is drawn over the observed screen, so the change reads as part of the real app rather than a new one.
  const screen = (background: string | null, overlay: Overlay, content = ""): string => {
    const base = background ? `<img class="observed-screen" src="${background}" alt="" />` : `${appHeader}<div class="demo-screen"></div>`;
    const scrim = overlay === "sheet" ? `<div class="scrim"></div>` : "";
    return `${base}${scrim}${overlay === "none" ? "" : `<div class="overlay ${overlay}">${content}</div>`}`;
  };
  // A resume screen other than the entry means the offer follows leaving the entry, such as a closed paywall, so it appears there.
  const offerScreenshot = resume.stateId === evidenceId ? screenshot : resume.screenshot;
  const steps = {
    observed: phone("01 · Existing state", false, screen(screenshot, "none")),
    trigger: phone("02 · Proposed mechanic", true, screen(offerScreenshot, "banner",
      `<span class="play" aria-hidden="true">▶</span><span><strong>${escapeHtml(reward)}</strong><small>Watch a short ad · optional</small></span>`)),
    offer: phone("03 · Clear choice", true, screen(offerScreenshot, "sheet",
      `<p class="mock-eyebrow">Optional reward</p><h3>${escapeHtml(reward)}</h3><p>Watch a short ad to get it. Skip it and nothing changes.</p>${button("Watch ad")}${button("No thanks", true)}`)),
    ad: phone("04 · Rewarded ad", true, screen(null, "full",
      `<div class="ad-top"><span>Reward in 0:12</span><span class="ad-close" aria-hidden="true">×</span></div><div class="ad-creative">Sponsored</div><div class="ad-progress"><span></span></div>`)),
    granted: phone("05 · Reward granted", true, screen(resume.screenshot, "toast",
      `<span class="check" aria-hidden="true">✓</span><span><strong>Reward unlocked</strong><small>${escapeHtml(reward)}</small></span>`)),
    resumed: phone("06 · Back to the task", true, screen(resume.screenshot, "banner",
      `<span class="check" aria-hidden="true">✓</span><span><strong>${escapeHtml(reward)}</strong><small>Ready to use here</small></span>`)),
  };
  const arrow = `<span class="flow-arrow" aria-hidden="true">→</span>`;
  const slide = (part: number, heading: string, lead: string, left: string, right: string, notes: string) =>
    `<section class="slide"><div class="slide-top"><span>${prefix}</span><span>Part ${part} of 3</span></div><h1>${escapeHtml(heading)}</h1><p class="lead">${escapeHtml(lead)}</p>` +
    `<div class="story">${left}${arrow}${right}<div class="notes">${notes}</div></div></section>`;
  return [
    slide(1, title, preview(proposal.userNeed, 145), steps.observed, steps.trigger,
      `<h2>What changes</h2><p>An optional ad offer unlocks ${escapeHtml(reward.toLowerCase())}. The original task remains available.</p><h2>Where it appears</h2><p>${escapeHtml(preview(observedSummary, 170))}</p><p class="source">${source}</p>`),
    slide(2, "The user chooses the exchange", preview(proposal.optIn, 145), steps.offer, steps.ad,
      `<h2>If they decline</h2><p>${escapeHtml(preview(proposal.declinePath, 145))}</p><h2>If the ad fails</h2><p>If no ad is available, the offer is hidden and the existing path remains.</p><p class="source">Ad content is simulated. ${source}</p>`),
    slide(3, "Value arrives before the task resumes", preview(proposal.fulfillment, 145), steps.granted, steps.resumed,
      `<h2>Product case</h2><p>${escapeHtml(preview(proposal.businessImpact, 170))}</p><h2>What to validate</h2><p>${escapeHtml(validation)}</p><p class="source">${source}</p>`),
  ];
}

export async function runPresent(options: {
  projectRoot: string;
  demo?: boolean;
  appKey?: string;
  runId?: string;
  recommendationDirectory?: string;
  mockDirectory?: string;
  proposalId?: string;
}): Promise<{ outputDirectory: string; slides: number; approved: number }> {
  const [template, rendererSource] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL(import.meta.url)),
  ]);
  let concepts: Concept[];
  let appName: string;
  let outputRoot: string;
  let mockLink: string | null = null;
  const inputHash = createHash("sha256").update(template).update(rendererSource);
  if (options.demo) {
    if (options.appKey || options.runId || options.recommendationDirectory || options.mockDirectory || options.proposalId) {
      throw new Error("--demo cannot be combined with run inputs");
    }
    concepts = [{ proposal: demoProposal, observedScreen: "Demo chat limit", observedSummary: "The conversation is paused at an illustrative limit.", evidenceId: "demo-chat-limit", evidencePath: null, screenshot: null,
      resume: { stateId: "demo-chat-limit", screen: "Demo chat limit", screenshot: null } }];
    appName = "Sample app";
    outputRoot = join(options.projectRoot, "runs", "demo", "flows");
    inputHash.update(JSON.stringify(concepts));
  } else {
    const { appKey, runId, recommendationDirectory, mockDirectory } = options;
    if (!appKey || !/^[a-z0-9_-]+$/.test(appKey) || !runId || !/^[a-zA-Z0-9_-]+$/.test(runId) || !recommendationDirectory || !mockDirectory) {
      throw new Error("Present requires --app, --run, --recommend-dir, and --mock-dir");
    }
    const runDirectory = await realpath(join(options.projectRoot, "runs", appKey, runId));
    const recommendationRoot = await realpath(recommendationDirectory);
    const mockRoot = await realpath(mockDirectory);
    for (const directory of [recommendationRoot, mockRoot]) {
      const path = relative(runDirectory, directory);
      if (path.startsWith("..") || isAbsolute(path)) throw new Error("Present inputs must belong to the selected run");
    }
    const [snapshotBytes, proposalBytes, judgmentBytes, mockBytes] = await Promise.all([
      readFile(join(runDirectory, "product-model.json")),
      readFile(join(recommendationRoot, "proposals.json")),
      readFile(join(recommendationRoot, "judgments.json")),
      readFile(join(mockRoot, "manifest.json")),
    ]);
    const snapshot = JSON.parse(snapshotBytes.toString()) as ProductModel;
    const proposalFile = JSON.parse(proposalBytes.toString()) as { runId: string; proposals: Proposal[] };
    const judgmentFile = JSON.parse(judgmentBytes.toString()) as { runId: string; judgments: Judgment[]; approvedProposalIds: string[] };
    const mock = JSON.parse(mockBytes.toString()) as MockManifest;
    validateSnapshot(snapshot);
    if (snapshot.runId !== runId || snapshot.app.key !== appKey || proposalFile.runId !== runId || judgmentFile.runId !== runId || mock.runId !== runId || mock.app !== appKey) {
      throw new Error("Present inputs do not match the selected run");
    }
    const evidenceIds = new Set([
      ...snapshot.states.map((state) => state.id),
      ...snapshot.transitions.map((transition) => transition.id),
      ...snapshot.states.flatMap((state) => state.monetization.map((fact) => fact.id)),
    ]);
    concepts = [];
    const readScreenshot = async (state: ProductModel["states"][number]): Promise<string> => {
      const screenshotPath = await realpath(resolve(options.projectRoot, state.evidence[0]!.screenshot));
      const path = relative(runDirectory, screenshotPath);
      if (path.startsWith("..") || isAbsolute(path)) throw new Error(`Screenshot for ${state.id} is outside this run`);
      const imageBytes = await readFile(screenshotPath);
      if (!imageBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new Error(`Screenshot for ${state.id} is not a PNG`);
      }
      inputHash.update(imageBytes);
      return `data:image/png;base64,${imageBytes.toString("base64")}`;
    };
    const approvedIds = options.proposalId ? [options.proposalId] : judgmentFile.approvedProposalIds;
    for (const proposalId of approvedIds) {
      if (!judgmentFile.approvedProposalIds.includes(proposalId)) throw new Error(`Proposal ${proposalId} is not approved`);
      const decisions = judgmentFile.judgments.filter((judgment) => judgment.proposalId === proposalId)
        .sort((left, right) => right.revision - left.revision);
      const judgment = decisions[0];
      const proposal = proposalFile.proposals.find((item) => item.id === proposalId && item.revision === judgment?.revision);
      const state = snapshot.states.find((item) => item.id === proposal?.entryStateId);
      const resumeState = snapshot.states.find((item) => item.id === (proposal?.resumeStateId ?? proposal?.entryStateId));
      if (!judgment || judgment.decision !== "pass" || judgment.hardFailures.length || !proposal || !state || !resumeState ||
          !proposal.evidenceIds.length || proposal.evidenceIds.some((id) => !evidenceIds.has(id)) ||
          !mock.states.some((item) => item.id === state.id)) {
        throw new Error(`Approved proposal ${proposalId} has no valid final pass, entry state, or mock state`);
      }
      const [screenshot, resumeScreenshot] = [await readScreenshot(state), await readScreenshot(resumeState)];
      concepts.push({ proposal, observedScreen: state.screen, observedSummary: state.summary,
        evidenceId: state.id, evidencePath: state.evidence[0]!.screenshot, screenshot,
        resume: { stateId: resumeState.id, screen: resumeState.screen, screenshot: resumeScreenshot } });
    }
    appName = appKey;
    outputRoot = join(runDirectory, "flows");
    inputHash.update(snapshotBytes).update(proposalBytes).update(judgmentBytes).update(mockBytes);
    mockLink = mockRoot;
  }
  const outputDirectory = join(outputRoot, inputHash.update(options.proposalId ?? "").digest("hex"));
  const slides = concepts.flatMap((concept) => conceptSlides(concept, appName, Boolean(options.demo)));
  if (!slides.length) slides.push(`<section class="slide empty"><div class="slide-top"><span>Appraise · ${escapeHtml(appName)}</span><span>1 / 1</span></div><h1>No approved recommendation</h1><p>No proposal passed the judge for this run. Review the judgments before presenting an idea.</p></section>`);
  const link = mockLink ? `<a class="mock-link" href="${escapeHtml(relative(outputDirectory, join(mockLink, "index.html")))}">Open interactive mock ↗</a>` : "";
  const html = template.replace("__SLIDES__", slides.join("\n"))
    .replace("__MOCK_LINK__", link)
    .replace("__DEMO_LABEL__", options.demo ? "Demo data · not an observed app" : "Observed screens and illustrative proposed screens");
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outputDirectory, "index.html"), html),
    writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify({
      app: appName, runId: options.runId ?? null, demo: Boolean(options.demo),
      approvedProposalIds: concepts.map((concept) => concept.proposal.id),
      sources: concepts.map((concept) => ({
        proposalId: concept.proposal.id, revision: concept.proposal.revision,
        entryStateId: concept.evidenceId, resumeStateId: concept.resume.stateId, screenshot: concept.evidencePath,
      })),
      slides: slides.length, recommendationDirectory: options.recommendationDirectory ?? null,
      mockDirectory: options.mockDirectory ?? null,
    }, null, 2)}\n`),
  ]);
  return { outputDirectory, slides: slides.length, approved: concepts.length };
}
