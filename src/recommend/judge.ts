import { Agent, run } from "@openai/agents";
import type { Model } from "@openai/agents";
import { z } from "zod";

import type { Judgment, JudgmentScores, Proposal } from "../domain/proposal.ts";

export type Assessment = {
  scores: JudgmentScores;
  hardFailures: string[];
  rationale: string;
  feedback: string;
};

export interface Judge {
  assess(proposal: Proposal): Promise<Assessment>;
}

const assessmentSchema = z.object({
  scores: z.object({
    userValue: z.number().int().min(1).max(5),
    contextFit: z.number().int().min(1).max(5),
    businessFit: z.number().int().min(1).max(5),
    feasibility: z.number().int().min(1).max(5),
    evidence: z.number().int().min(1).max(5),
  }),
  hardFailures: z.array(z.string()),
  rationale: z.string().min(1),
  feedback: z.string(),
}) satisfies z.ZodType<Assessment>;

const instructions = [
  "Independently review one rewarded-ad product proposal against the shared app context: observed states with their monetization facts, observed transitions, and optional supplemental pricing context. Review it as a product hypothesis for further validation, not a launch-ready build. Do not assume the proposer verified its own claims. Assess each proposal on its own merits; a plausible idea can still be unsupported by this app's observations.",
  "List a hard failure if the proposed reward has no clear value for the user's task, is internally impossible or contradicts observed behavior, the offer fails to explain the exchange before the ad, the user cannot clearly opt in or decline without losing normal use, fulfillment after successful completion is undefined, or an existing value anchor is claimed without mobile evidence. Check that cited observations support the claimed relationship: a quota, button, or entitlement observed in one workflow cannot be applied to a different workflow without evidence connecting them. This includes using generation results from one workflow to claim that another workflow's quota badge updates. Check user-facing offer and upsell copy against exact observed paid benefits: a 2× image allowance cannot be described as unlimited images. An observed screen may host a proposed new offer; do not demand that the proposed UI, ad SDK, or future quota count already appear in the app. Unknown SDK integration, ad fill, costs, and audience size belong in feasibility or business scores and the validation plan when the proposal names them honestly and provides a failure path. If in-app purchases are known but the pricing model lacks plan prices or paid entitlements, list that gap as a hard failure; business fit cannot be approved without those terms.",
  "Score userValue, contextFit, businessFit, feasibility, and evidence from 1 to 5. A score of 3 means plausible but uncertain; 5 requires a clear fit supported by evidence. For businessFit, consider whether the offer would divert users who would otherwise pay, for example by appearing on a paywall or granting what the subscription sells; that risk lowers the score. For feasibility, 3 means a coherent proposed implementation with ordinary unverified dependencies such as adding a rewarded-ad SDK and server-side completion callback; 2 means a specific technical obstacle or contradiction beyond those normal dependencies. Evidence measures support for the observed user task, entry surface, value anchor, and paid-benefit tradeoff; it need not include a screenshot of a proposed future state or population-level analytics. Explain the scores and cite relevant evidence IDs in rationale. Unknown conversion, revenue, fill rate, retention, and service costs remain unknown; do not invent precision. Feedback should identify a concrete fix when one is possible.",
].join("\n\n");

export class ModelJudge implements Judge {
  readonly usage: Array<{ stage: "judge"; requests: number; inputTokens: number; outputTokens: number }> = [];
  private readonly agent: Agent<unknown, typeof assessmentSchema>;

  constructor(
    model: string | Model,
    private readonly appContext: string,
  ) {
    this.agent = new Agent({ name: "Rewarded opportunity judge", model, instructions, outputType: assessmentSchema });
  }

  async assess(proposal: Proposal): Promise<Assessment> {
    const outcome = await run(this.agent, `Shared app context: ${this.appContext}\nProposal to assess: ${JSON.stringify(proposal)}`, { maxTurns: 1 });
    const { requests, inputTokens, outputTokens } = outcome.runContext.usage;
    this.usage.push({ stage: "judge", requests, inputTokens, outputTokens });
    if (!outcome.finalOutput) throw new Error(`Judge returned no assessment for ${proposal.id}`);
    return assessmentSchema.parse(outcome.finalOutput);
  }
}

export function decide(proposal: Proposal, assessment: Assessment): Judgment {
  const scores = [
    assessment.scores.userValue,
    assessment.scores.contextFit,
    assessment.scores.businessFit,
    assessment.scores.feasibility,
    assessment.scores.evidence,
  ];
  if (scores.some((score) => !Number.isInteger(score) || score < 1 || score > 5)) {
    throw new Error(`Judge returned an invalid score for ${proposal.id}`);
  }
  const passes = assessment.hardFailures.length === 0 && scores.every((score) => score >= 3) &&
    assessment.scores.userValue >= 4 && assessment.scores.contextFit >= 4 && assessment.scores.evidence >= 4;
  return {
    proposalId: proposal.id,
    revision: proposal.revision,
    ...assessment,
    decision: passes ? "pass" : assessment.hardFailures.length > 0 ? "reject" : "revise",
  };
}
