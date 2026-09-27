import { Agent, run } from "@openai/agents";
import type { Model } from "@openai/agents";
import { z } from "zod";

import type { Judgment, Proposal } from "../domain/proposal.ts";

export const proposalSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().nonnegative(),
  title: z.string().min(1),
  opportunityType: z.enum(["existing", "product_change"]),
  entryStateId: z.string().min(1),
  resumeStateId: z.string().min(1),
  evidenceIds: z.array(z.string().min(1)).min(1),
  trigger: z.string().min(1),
  userNeed: z.string().min(1),
  eligibility: z.string().min(1),
  productChange: z.string().min(1),
  reward: z.string().min(1),
  optIn: z.string().min(1),
  fulfillment: z.string().min(1),
  declinePath: z.string().min(1),
  failurePath: z.string().min(1),
  businessImpact: z.string().min(1),
  validationPlan: z.string().min(1),
  assumptions: z.array(z.string()),
  screens: z.object({
    entry: z.object({ title: z.string().min(1), detail: z.string().min(1) }),
    choice: z.object({ title: z.string().min(1), detail: z.string().min(1), accept: z.string().min(1), decline: z.string().min(1) }),
    inUse: z.object({ request: z.string().min(1), response: z.string().min(1), badge: z.string().min(1) }),
    after: z.object({ title: z.string().min(1), detail: z.string().min(1) }),
  }),
}) satisfies z.ZodType<Proposal>;

export interface Proposer {
  propose(): Promise<Proposal[]>;
  revise(proposal: Proposal, feedback: Judgment): Promise<Proposal>;
}

const instructions = [
  "Design rewarded-ad opportunities for the observed mobile app. Produce distinct product mechanisms, not copy variations. Consider both existing value anchors and product changes; do not invent an existing anchor when none was observed.",
  "For every candidate, start with the user's task and the value the app could grant after an ad. Explain why that value matters at the trigger, who is eligible, the offer UI or product change, affirmative opt-in, decline path, reward fulfillment, and the path when an ad is unavailable or unfinished. State possible effects on subscriptions, paid benefits, normal usage, and service costs. Name an experiment that could validate the uncertain business outcome.",
  "Read the shared app context first: observed states with their monetization facts, observed transitions, and optional supplemental pricing context. Core user tasks are core, non-modal states; core user flows are transitions leaving core states; value anchors are observed quota, currency, or entitlement facts. Observed value anchors are clues, not proof that extra value can be granted; a proposed new reward mechanic must be labeled as a product change. Cite only state, transition, or monetization IDs from the context. Monetization facts are mobile observations and supplementalContext is not; neither a generic in-app-purchase label nor a quota alone establishes plan prices and paid benefits. Keep offer copy faithful to the exact paid entitlement: a 2× allowance is not unlimited access. Put unknown grantability, pricing, costs, and business metrics in assumptions. Never present an estimate of revenue uplift as measured fact.",
  "When a subscription paywall was observed, consider whether an optional, one-use sample after the user declines would help them understand a specific paid benefit. Keep the normal exit and subscription offer intact; label any new decline or sample flow as proposed if it was not observed. Rewarded value must not undercut existing monetization: a user who would pay should still see and choose the paid path first, so place the offer after the user declines or leaves a purchase surface rather than on it, and keep the reward smaller than the paid benefit.",
  "entryStateId is the observed state where the trigger happens. resumeStateId is the observed state where the user continues their task after receiving the reward: usually the entry state, but when the offer follows leaving a screen, such as closing a paywall, it is the state that screen returns to, and the offer appears there. Cite both in evidenceIds, with the transition between them when one was observed.",
  "screens is the short copy a user would see on each proposed screen, each line at most 60 characters and faithful to the exact reward: entry is the offer as it first appears on the page; choice is the opt-in sheet with a title, one line on the exchange, and accept and decline labels; inUse shows the reward being used in the user's own task, as the request or action the user makes, what the app returns because of the reward, and a small badge marking it as the rewarded use; after is what the user sees once the reward is used up, making clear that normal use and the paid path are unchanged.",
  "Place the offer on an observed screen or transition. Verify that the cited trigger and control belong to the same user flow; a quota shown in one workflow does not prove that it also governs another workflow's regenerate or edit action. Observations from another workflow cannot establish how this workflow's badge or counter updates. A visible quota counter does not establish what happens at exhaustion, and a listed paid benefit does not establish where free access is blocked. Label unobserved gates and reward grants as product changes instead of claiming they already exist. An added limit must have independent product value; do not reduce existing free value solely to create ad demand. Return 2–5 candidates when the evidence supports them, or an empty list when the app is too poorly observed.",
].join("\n\n");

const proposalListSchema = z.object({ proposals: z.array(proposalSchema) });

export class ModelProposer implements Proposer {
  readonly usage: Array<{ stage: "propose" | "revise"; requests: number; inputTokens: number; outputTokens: number }> = [];
  private readonly proposeAgent: Agent<unknown, typeof proposalListSchema>;
  private readonly reviseAgent: Agent<unknown, typeof proposalSchema>;

  constructor(
    model: string | Model,
    private readonly appContext: string,
  ) {
    const name = "Rewarded opportunity proposer";
    this.proposeAgent = new Agent({ name, model, instructions, outputType: proposalListSchema });
    this.reviseAgent = new Agent({ name, model, instructions, outputType: proposalSchema });
  }

  async propose(): Promise<Proposal[]> {
    const outcome = await run(this.proposeAgent, this.input("Generate candidate opportunities."), { maxTurns: 1 });
    const { requests, inputTokens, outputTokens } = outcome.runContext.usage;
    this.usage.push({ stage: "propose", requests, inputTokens, outputTokens });
    if (!outcome.finalOutput) throw new Error("Proposer returned no output");
    return proposalListSchema.parse(outcome.finalOutput).proposals;
  }

  async revise(proposal: Proposal, feedback: Judgment): Promise<Proposal> {
    const outcome = await run(this.reviseAgent, this.input(`Revise only this candidate.\nCandidate: ${JSON.stringify(proposal)}\nJudge feedback: ${JSON.stringify(feedback)}`), { maxTurns: 1 });
    const { requests, inputTokens, outputTokens } = outcome.runContext.usage;
    this.usage.push({ stage: "revise", requests, inputTokens, outputTokens });
    if (!outcome.finalOutput) throw new Error(`Proposer returned no revision for ${proposal.id}`);
    return proposalSchema.parse(outcome.finalOutput);
  }

  private input(task: string): string {
    return `${task}\nShared app context: ${this.appContext}`;
  }
}
