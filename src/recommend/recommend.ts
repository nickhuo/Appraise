import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import type { Model } from "@openai/agents";

import type { ProductModel } from "../domain/product-model.ts";
import { validateSnapshot } from "../domain/product-model.ts";
import type { Judgment, Proposal, Recommendation } from "../domain/proposal.ts";
import { decide, type Judge, ModelJudge } from "./judge.ts";
import { ModelProposer, type Proposer } from "./proposer.ts";

const MAX_CANDIDATES = 5;
const MAX_REVISIONS = 1;

export async function recommend(
  snapshot: ProductModel,
  proposer: Proposer,
  judge: Judge,
): Promise<Recommendation> {
  validateSnapshot(snapshot);
  const stateIds = new Set(snapshot.states.map((state) => state.id));
  const evidenceIds = new Set([
    ...stateIds,
    ...snapshot.transitions.map((transition) => transition.id),
    ...snapshot.states.flatMap((state) => state.monetization.map((fact) => fact.id)),
  ]);
  // Code owns candidate identity; the model's ID is only a readable slug.
  const takenIds = new Set<string>();
  const initial = (await proposer.propose()).slice(0, MAX_CANDIDATES).map((draft) => {
    let id = draft.id;
    for (let suffix = 2; takenIds.has(id); suffix++) id = `${draft.id}-${suffix}`;
    takenIds.add(id);
    return { ...draft, id, revision: 0 };
  });
  const proposals: Proposal[] = [];
  const judgments: Judgment[] = [];
  const approvedProposalIds: string[] = [];
  for (let proposal of initial) {
    for (;;) {
      proposals.push(proposal);
      const evidenceProblems = [
        ...(stateIds.has(proposal.entryStateId) ? [] : [`entryStateId ${proposal.entryStateId} is not an observed state`]),
        ...(proposal.resumeStateId && !stateIds.has(proposal.resumeStateId) ? [`resumeStateId ${proposal.resumeStateId} is not an observed state`] : []),
        ...(proposal.evidenceIds.length > 0 ? [] : ["evidenceIds is empty"]),
        ...proposal.evidenceIds.filter((id) => !evidenceIds.has(id)).map((id) => `Evidence ID ${id} does not exist`),
      ];
      const assessed = decide(proposal, await judge.assess(proposal));
      // Bad citations are fixable, so they cap the verdict at revise rather than reject.
      const decision = assessed.decision === "pass" && evidenceProblems.length > 0 ? "revise" : assessed.decision;
      const judgment: Judgment = {
        ...assessed,
        decision: decision === "revise" && proposal.revision === MAX_REVISIONS ? "reject" : decision,
        feedback: [...evidenceProblems, assessed.feedback].filter(Boolean).join("\n"),
      };
      judgments.push(judgment);
      if (judgment.decision === "pass") approvedProposalIds.push(proposal.id);
      if (judgment.decision !== "revise") break;
      proposal = { ...(await proposer.revise(proposal, judgment)), id: proposal.id, revision: proposal.revision + 1 };
    }
  }
  return { runId: snapshot.runId, proposals, judgments, approvedProposalIds };
}

export async function runRecommend(options: {
  projectRoot: string;
  appKey: string;
  runId: string;
  contextPath?: string;
  previousDirectory?: string;
  model?: string | Model;
}): Promise<{ outputDirectory: string; proposals: number; approved: number }> {
  if (!/^[a-z0-9_-]+$/.test(options.appKey) || !/^[a-zA-Z0-9_-]+$/.test(options.runId)) {
    throw new Error("Invalid app or run ID");
  }
  const runDirectory = await realpath(join(options.projectRoot, "runs", options.appKey, options.runId));
  const snapshotBytes = await readFile(join(runDirectory, "product-model.json"));
  const snapshot = JSON.parse(snapshotBytes.toString()) as ProductModel;
  validateSnapshot(snapshot);
  if (snapshot.app.key !== options.appKey || snapshot.runId !== options.runId) {
    throw new Error("Product model does not match the requested run");
  }
  const context = options.contextPath ? await readFile(options.contextPath, "utf8") : null;
  if (context !== null && !context.trim()) throw new Error("Supplemental context file is empty");
  let previousReview: string | null = null;
  if (options.previousDirectory) {
    const previousDirectory = await realpath(options.previousDirectory);
    const path = relative(runDirectory, previousDirectory);
    if (path.startsWith("..") || isAbsolute(path)) throw new Error("Previous recommendation must belong to this run");
    const previousProposals = JSON.parse(await readFile(join(previousDirectory, "proposals.json"), "utf8")) as { runId: string; proposals: Proposal[] };
    const previousJudgments = JSON.parse(await readFile(join(previousDirectory, "judgments.json"), "utf8")) as { runId: string; judgments: Judgment[] };
    if (previousProposals.runId !== snapshot.runId || previousJudgments.runId !== snapshot.runId) {
      throw new Error("Previous recommendation does not match the selected run");
    }
    const finalJudgments = new Map<string, Judgment>();
    for (const judgment of previousJudgments.judgments) {
      const current = finalJudgments.get(judgment.proposalId);
      if (!current || judgment.revision > current.revision) finalJudgments.set(judgment.proposalId, judgment);
    }
    previousReview = JSON.stringify([...finalJudgments.values()].map((judgment) => ({
      proposal: previousProposals.proposals.find((proposal) => proposal.id === judgment.proposalId && proposal.revision === judgment.revision),
      decision: judgment.decision, scores: judgment.scores, feedback: judgment.feedback, rationale: judgment.rationale,
    })));
  }
  const appContext = {
    runId: snapshot.runId,
    app: snapshot.app,
    runStatus: snapshot.runStatus,
    stopReason: snapshot.stopReason,
    states: snapshot.states.map((state) => ({
      id: state.id, screen: state.screen, variant: state.variant, summary: state.summary,
      isCore: state.isCore, isModal: state.isModal, copy: state.visual.copy,
      groups: state.groups.map((group) => ({
        key: group.key, description: group.description, isCore: group.isCore, coverage: group.coverage,
      })),
      monetization: state.monetization,
      observationSteps: state.evidence.map((evidence) => evidence.step),
    })),
    transitions: snapshot.transitions.map((transition) => ({
      id: transition.id, from: transition.from, to: transition.to,
      action: { type: transition.action.type, targetRef: transition.action.targetRef, text: transition.action.text },
      outcome: transition.outcome, changeSummary: transition.changeSummary,
      observationStep: transition.evidence.step,
    })),
    supplementalContext: context === null ? null : { source: options.contextPath, text: context },
  };
  const model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-6-sol";
  const sharedContext = JSON.stringify(appContext);
  const proposer = new ModelProposer(model, previousReview
    ? `${sharedContext}\nPrior review of this run, which may predate current evidence: ${previousReview}\nUse feedback and factual checks to improve earlier mechanisms or find different ones. A prior pass is not proof that every factual claim is correct. Prior opinions are not mobile observations.`
    : sharedContext);
  const judge = new ModelJudge(model, sharedContext);
  const recommendation = await recommend(snapshot, proposer, judge);
  const outputDirectory = join(runDirectory, "recommend", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  await mkdir(outputDirectory, { recursive: true });
  const inputHash = createHash("sha256").update(snapshotBytes).update(context ?? "").update(previousReview ?? "").digest("hex");
  await Promise.all([
    writeFile(join(outputDirectory, "app-context.json"), `${JSON.stringify(appContext, null, 2)}\n`),
    writeFile(join(outputDirectory, "proposals.json"), `${JSON.stringify({ runId: snapshot.runId, proposals: recommendation.proposals }, null, 2)}\n`),
    writeFile(join(outputDirectory, "judgments.json"), `${JSON.stringify({ runId: snapshot.runId, judgments: recommendation.judgments, approvedProposalIds: recommendation.approvedProposalIds }, null, 2)}\n`),
    writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify({
      runId: snapshot.runId,
      inputHash,
      contextSource: options.contextPath ?? null,
      previousRecommendation: options.previousDirectory ?? null,
      model: typeof model === "string" ? model : "injected-model",
      promptVersion: 2,
      usage: [...proposer.usage, ...judge.usage],
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`),
  ]);
  return { outputDirectory, proposals: recommendation.proposals.length, approved: recommendation.approvedProposalIds.length };
}
