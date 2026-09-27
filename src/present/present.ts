import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { MockManifest } from "../domain/mock.ts";
import type { ProductModel } from "../domain/product-model.ts";
import { validateSnapshot } from "../domain/product-model.ts";
import type { Judgment, Proposal, ProposalScreens } from "../domain/proposal.ts";

type Concept = {
  proposal: Proposal;
  observedScreen: string;
  observedSummary: string;
  evidenceId: string;
  evidencePath: string;
  screenshot: string;
  resume: { stateId: string; screen: string; screenshot: string };
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

type Overlay = "none" | "banner" | "sheet" | "full" | "use";

function phone(label: string, isProposed: boolean, screen: string): string {
  return `<figure class="phone-wrap"><figcaption class="phone-label">${escapeHtml(label)}<span class="phone-tag${isProposed ? " proposed" : ""}">${isProposed ? "Proposed" : "Observed"}</span></figcaption><div class="phone">${screen}</div></figure>`;
}

function conceptSlides(concept: Concept): string[] {
  const { proposal, observedScreen, observedSummary, evidenceId, screenshot, resume } = concept;
  // Proposals written before on-screen copy existed get generic copy built from a short reward label.
  const reward = preview(proposal.reward.replace(/^(?:after|once|when|if)\b[^,]*,\s*/i, "").replace(/^the user (?:can|gets|receives)\s+/i, "").split(/[,;.—]|\s(?:after|before|when|once|not)\s|\b(?:applied|credited|delivered|granted)\b/i)[0]!.trim()
    .replace(/^One additional /i, "One extra ").replace(/^\w/, (first) => first.toUpperCase()), 72);
  const copy: ProposalScreens = proposal.screens ?? {
    entry: { title: reward, detail: "Watch a short ad · optional" },
    choice: { title: reward, detail: "Watch a short ad to get it. Skip it and nothing changes.", accept: "Watch ad", decline: "No thanks" },
    inUse: { request: "", response: reward, badge: "Reward" },
    after: { title: "Reward used", detail: "Normal use continues" },
  };
  const title = preview(proposal.title.split(",")[0]!, 100);
  const validation = proposal.assumptions.slice(0, 2)
    .map((assumption) => preview(assumption
      .replace(/\s*\((?:state|evidence|coverage)[^)]*\)/gi, "")
      .replace(/\s+in state [0-9a-f-]+/gi, ""), 145))
    .join(" ") || preview(proposal.validationPlan, 170);
  const prefix = `Proposal ${escapeHtml(proposal.id)} · revision ${escapeHtml(String(proposal.revision))}`;
  const source = `Observed screen: ${escapeHtml(observedScreen)} · evidence: ${escapeHtml(evidenceId)}` +
    (resume.stateId !== evidenceId ? ` · resumes on ${escapeHtml(resume.screen)} (${escapeHtml(resume.stateId)})` : "");
  const button = (copy: string, secondary = false): string => `<div class="mock-button${secondary ? " secondary" : ""}">${escapeHtml(copy)}</div>`;
  // Proposed UI is drawn over the observed screen, so the change reads as part of the real app rather than a new one.
  const screen = (background: string | null, overlay: Overlay, content = ""): string => {
    const base = background ? `<img class="observed-screen" src="${background}" alt="" />` : "";
    const scrim = overlay === "sheet" ? `<div class="scrim"></div>` : "";
    return `${base}${scrim}${overlay === "none" ? "" : `<div class="overlay ${overlay}">${content}</div>`}`;
  };
  // A resume screen other than the entry means the offer follows leaving the entry, such as a closed paywall, so it appears there.
  const offerScreenshot = resume.stateId === evidenceId ? screenshot : resume.screenshot;
  const steps = {
    observed: phone("01 · Existing state", false, screen(screenshot, "none")),
    trigger: phone("02 · Proposed mechanic", true, screen(offerScreenshot, "banner",
      `<span class="play" aria-hidden="true">▶</span><span><strong>${escapeHtml(copy.entry.title)}</strong><small>${escapeHtml(copy.entry.detail)}</small></span>`)),
    offer: phone("03 · Clear choice", true, screen(offerScreenshot, "sheet",
      `<p class="mock-eyebrow">Optional reward</p><h3>${escapeHtml(copy.choice.title)}</h3><p>${escapeHtml(copy.choice.detail)}</p>${button(copy.choice.accept)}${button(copy.choice.decline, true)}`)),
    ad: phone("04 · Rewarded ad", true, screen(null, "full",
      `<div class="ad-top"><span>Reward in 0:12</span><span class="ad-close" aria-hidden="true">×</span></div><div class="ad-creative">Sponsored</div><div class="ad-progress"><span></span></div>`)),
    inUse: phone("05 · Reward in use", true, screen(resume.screenshot, "use",
      (copy.inUse.request ? `<p class="request">${escapeHtml(copy.inUse.request)}</p>` : "") +
      `<div class="response"><span class="reward-badge"><span aria-hidden="true">✓</span> ${escapeHtml(copy.inUse.badge)}</span><p>${escapeHtml(copy.inUse.response)}</p></div>`)),
    after: phone("06 · After the reward", true, screen(resume.screenshot, "banner",
      `<span class="info" aria-hidden="true">i</span><span><strong>${escapeHtml(copy.after.title)}</strong><small>${escapeHtml(copy.after.detail)}</small></span>`)),
  };
  const arrow = `<span class="flow-arrow" aria-hidden="true">→</span>`;
  const slide = (part: number, heading: string, lead: string, left: string, right: string, notes: string) =>
    `<section class="slide"><div class="slide-top"><span>${prefix}</span><span>Part ${part} of 3</span></div><h1>${escapeHtml(heading)}</h1><p class="lead">${escapeHtml(lead)}</p>` +
    `<div class="story">${left}${arrow}${right}<div class="notes">${notes}</div></div></section>`;
  return [
    slide(1, title, preview(proposal.userNeed, 145), steps.observed, steps.trigger,
      `<h2>What changes</h2><p>${escapeHtml(preview(proposal.productChange, 170))}</p><h2>Where it appears</h2><p>${escapeHtml(preview(observedSummary, 170))}</p><p class="source">${source}</p>`),
    slide(2, "The user chooses the exchange", preview(proposal.optIn, 145), steps.offer, steps.ad,
      `<h2>If they decline</h2><p>${escapeHtml(preview(proposal.declinePath, 145))}</p><h2>If the ad fails</h2><p>If no ad is available, the offer is hidden and the existing path remains.</p><p class="source">Ad content is simulated. ${source}</p>`),
    slide(3, "The reward is used inside the task", preview(proposal.fulfillment, 145), steps.inUse, steps.after,
      `<h2>Product case</h2><p>${escapeHtml(preview(proposal.businessImpact, 170))}</p><h2>What to validate</h2><p>${escapeHtml(validation)}</p><p class="source">${source}</p>`),
  ];
}

export async function runPresent(options: {
  projectRoot: string;
  appKey: string;
  runId: string;
  recommendationDirectory: string;
  mockDirectory: string;
  proposalId?: string;
}): Promise<{ outputDirectory: string; slides: number; approved: number }> {
  const { appKey, runId, recommendationDirectory, mockDirectory } = options;
  if (!/^[a-z0-9_-]+$/.test(appKey) || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("Invalid app or run ID");
  const [template, rendererSource] = await Promise.all([
    readFile(new URL("./index.html", import.meta.url), "utf8"),
    readFile(new URL(import.meta.url)),
  ]);
  const inputHash = createHash("sha256").update(template).update(rendererSource);
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
  const concepts: Concept[] = [];
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
  const outputRoot = join(runDirectory, "flows");
  inputHash.update(snapshotBytes).update(proposalBytes).update(judgmentBytes).update(mockBytes);
  const outputDirectory = join(outputRoot, inputHash.update(options.proposalId ?? "").digest("hex"));
  const slides = concepts.flatMap(conceptSlides);
  if (!slides.length) slides.push(`<section class="slide empty"><div class="slide-top"><span>Appraise · ${escapeHtml(appKey)}</span><span>1 / 1</span></div><h1>No approved recommendation</h1><p>No proposal passed the judge for this run. Review the judgments before presenting an idea.</p></section>`);
  const link = `<a class="mock-link" href="${escapeHtml(relative(outputDirectory, join(mockRoot, "index.html")))}">Open interactive mock ↗</a>`;
  const html = template.replace("__SLIDES__", slides.join("\n")).replace("__MOCK_LINK__", link);
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(outputDirectory, "index.html"), html),
    writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify({
      app: appKey, runId,
      approvedProposalIds: concepts.map((concept) => concept.proposal.id),
      sources: concepts.map((concept) => ({
        proposalId: concept.proposal.id, revision: concept.proposal.revision,
        entryStateId: concept.evidenceId, resumeStateId: concept.resume.stateId, screenshot: concept.evidencePath,
      })),
      slides: slides.length, recommendationDirectory, mockDirectory,
    }, null, 2)}\n`),
  ]);
  return { outputDirectory, slides: slides.length, approved: concepts.length };
}
