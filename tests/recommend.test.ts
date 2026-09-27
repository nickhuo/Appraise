import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScriptedModel, assistantMessage } from "@openai/agents/testing";
import { describe, expect, test } from "bun:test";

import type { ProductModel } from "../src/domain/product-model.ts";
import type { Judgment, JudgmentScores, Proposal } from "../src/domain/proposal.ts";
import { type Assessment, decide, type Judge } from "../src/recommend/judge.ts";
import type { Proposer } from "../src/recommend/proposer.ts";
import { recommend, runRecommend } from "../src/recommend/recommend.ts";

const evidence = (step: number) => ({
  step,
  screenshot: `runs/app/run-1/screens/${step}.png`,
  elementTree: `runs/app/run-1/screens/${step}.elements.json`,
});
const state = (id: string, step: number): ProductModel["states"][number] => ({
  id,
  screen: id,
  variant: "default",
  summary: "",
  isCore: true,
  isModal: false,
  viewport: { width: 1080, height: 1920 },
  visual: { copy: [] },
  evidence: [evidence(step)],
  monetization: [],
  groups: [],
});
const SNAPSHOT: ProductModel = {
  runId: "run-1",
  runStatus: "complete",
  stopReason: "core_frontier_exhausted",
  app: { key: "app", packageId: "com.example", version: null },
  states: [
    state("chat", 0),
    { ...state("quota_exhausted", 1), monetization: [{ id: "m-quota", kind: "quota", description: "3 free messages", basis: "observed" }] },
  ],
  transitions: [{
    id: "t-send",
    from: "chat",
    to: "quota_exhausted",
    action: { type: "tap", targetRef: "send", x: null, y: null, text: null, submit: false, direction: "none", reason: "" },
    outcome: "changed",
    changeSummary: null,
    evidence: evidence(0),
  }],
};

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id,
    revision: 0,
    title: id,
    opportunityType: "existing",
    entryStateId: "quota_exhausted",
    resumeStateId: "quota_exhausted",
    evidenceIds: ["m-quota"],
    trigger: "quota exhausted",
    userNeed: "continue the conversation",
    eligibility: "free users",
    productChange: "Add a rewarded offer at the existing message limit",
    reward: "one extra message",
    optIn: "watch ad button",
    fulfillment: "credit granted after ad",
    declinePath: "dismiss",
    failurePath: "show the original limit",
    businessImpact: "may substitute for a paid message allowance",
    validationPlan: "measure reward use and subscription conversion",
    assumptions: [],
    screens: {
      entry: { title: "One more message", detail: "Watch a short ad" },
      choice: { title: "Keep chatting", detail: "Watch an ad for one message", accept: "Watch ad", decline: "No thanks" },
      inUse: { request: "One more question", response: "Here is the answer", badge: "Rewarded message" },
      after: { title: "Daily messages used", detail: "Upgrade for more" },
    },
    ...overrides,
  };
}

const GOOD: JudgmentScores = { userValue: 5, contextFit: 5, businessFit: 5, feasibility: 5, evidence: 5 };
const WEAK: JudgmentScores = { ...GOOD, userValue: 3 };
const assessment = (scores: JudgmentScores, hardFailures: string[] = []): Assessment =>
  ({ scores, hardFailures, rationale: "r", feedback: "f" });

class ScriptedJudge implements Judge {
  readonly seen: Proposal[] = [];
  constructor(private readonly verdict: (proposal: Proposal) => Assessment) {}
  async assess(proposal: Proposal): Promise<Assessment> {
    this.seen.push(proposal);
    return this.verdict(proposal);
  }
}

class ScriptedProposer implements Proposer {
  readonly revisions: Array<{ proposal: Proposal; feedback: Judgment }> = [];
  constructor(
    private readonly initial: Proposal[],
    private readonly reviseTo: (proposal: Proposal) => Proposal = (proposal) => ({ ...proposal, revision: proposal.revision + 1 }),
  ) {}
  async propose(): Promise<Proposal[]> { return this.initial; }
  async revise(proposal: Proposal, feedback: Judgment): Promise<Proposal> {
    this.revisions.push({ proposal, feedback });
    return this.reviseTo(proposal);
  }
}

describe("deterministic gate", () => {
  test("the model cannot pass a proposal below the thresholds", () => {
    for (const key of ["userValue", "contextFit", "evidence"] as const) {
      expect(decide(proposal("p"), assessment({ ...GOOD, [key]: 3 })).decision).toBe("revise");
    }
    for (const key of ["businessFit", "feasibility"] as const) {
      expect(decide(proposal("p"), assessment({ ...GOOD, [key]: 2 })).decision).toBe("revise");
      expect(decide(proposal("p"), assessment({ ...GOOD, [key]: 3 })).decision).toBe("pass");
    }
    expect(decide(proposal("p"), assessment(GOOD)).decision).toBe("pass");
  });

  test("any hard failure rejects, regardless of scores", () => {
    expect(decide(proposal("p"), assessment(GOOD, ["forced ad"])).decision).toBe("reject");
  });

  test("out-of-range or non-integer scores are an error, not a verdict", () => {
    for (const bad of [0, 6, 4.5, Number.NaN]) {
      expect(() => decide(proposal("p"), assessment({ ...GOOD, feasibility: bad }))).toThrow();
    }
  });
});

describe("orchestration", () => {
  test("rejected and revised candidates stay in the record; only final passes are approved", async () => {
    const proposer = new ScriptedProposer([proposal("pass"), proposal("reject"), proposal("fixed"), proposal("stuck")]);
    const judge = new ScriptedJudge((item) => {
      if (item.id === "pass") return assessment(GOOD);
      if (item.id === "reject") return assessment(GOOD, ["coerces the user"]);
      if (item.id === "fixed") return assessment(item.revision === 0 ? WEAK : GOOD);
      return assessment(WEAK);
    });
    const result = await recommend(SNAPSHOT, proposer, judge);
    expect(result.runId).toBe("run-1");
    expect(result.approvedProposalIds.sort()).toEqual(["fixed", "pass"]);
    expect(result.proposals.map((item) => `${item.id}@${item.revision}`).sort())
      .toEqual(["fixed@0", "fixed@1", "pass@0", "reject@0", "stuck@0", "stuck@1"]);
    const decisions = Object.fromEntries(result.judgments.map((item) => [`${item.proposalId}@${item.revision}`, item.decision]));
    expect(decisions).toEqual({
      "pass@0": "pass",
      "reject@0": "reject",
      "fixed@0": "revise",
      "fixed@1": "pass",
      "stuck@0": "revise",
      "stuck@1": "reject",
    });
  });

  test("each candidate is revised at most once and only after a revise verdict", async () => {
    const proposer = new ScriptedProposer([proposal("a"), proposal("b")]);
    const judge = new ScriptedJudge((item) => item.id === "a" ? assessment(WEAK) : assessment(GOOD, ["bad"]));
    await recommend(SNAPSHOT, proposer, judge);
    expect(proposer.revisions.map((item) => item.proposal.id)).toEqual(["a"]);
    expect(proposer.revisions[0]!.feedback.decision).toBe("revise");
  });

  test("zero passing candidates yields zero approvals", async () => {
    const result = await recommend(SNAPSHOT, new ScriptedProposer([proposal("a")]), new ScriptedJudge(() => assessment(WEAK)));
    expect(result.approvedProposalIds).toEqual([]);
    expect(result.judgments.map((item) => item.decision)).toEqual(["revise", "reject"]);
  });

  test("an approved proposal must cite evidence that exists in the product model, even if the judge scores it perfectly", async () => {
    const cases = [
      proposal("unknown-evidence", { evidenceIds: ["invented-screen"] }),
      proposal("no-evidence", { evidenceIds: [] }),
      proposal("partial-evidence", { evidenceIds: ["m-quota", "invented"] }),
      proposal("unknown-entry", { entryStateId: "paywall_v2" }),
      proposal("transition-as-entry", { entryStateId: "t-send" }),
    ];
    const proposer = new ScriptedProposer(cases);
    const result = await recommend(SNAPSHOT, proposer, new ScriptedJudge(() => assessment(GOOD)));
    expect(result.approvedProposalIds).toEqual([]);
    expect(result.judgments.map((item) => `${item.proposalId}@${item.revision}:${item.decision}`)).toEqual(
      cases.flatMap((item) => [`${item.id}@0:revise`, `${item.id}@1:reject`]),
    );
    expect(proposer.revisions.map((item) => item.feedback.feedback.split("\n")[0])).toEqual([
      "Evidence ID invented-screen does not exist",
      "evidenceIds is empty",
      "Evidence ID invented does not exist",
      "entryStateId paywall_v2 is not an observed state",
      "entryStateId t-send is not an observed state",
    ]);
  });

  test("a revision can fix invented evidence and pass", async () => {
    const proposer = new ScriptedProposer([proposal("a", { evidenceIds: ["invented"] })], (item) => ({ ...item, evidenceIds: ["m-quota"] }));
    const result = await recommend(SNAPSHOT, proposer, new ScriptedJudge(() => assessment(GOOD)));
    expect(result.approvedProposalIds).toEqual(["a"]);
  });

  test("a revision cannot introduce invented evidence", async () => {
    const proposer = new ScriptedProposer([proposal("a")], (item) => ({ ...item, revision: 1, evidenceIds: ["invented"] }));
    const judge = new ScriptedJudge((item) => assessment(item.revision === 0 ? WEAK : GOOD));
    const result = await recommend(SNAPSHOT, proposer, judge);
    expect(result.approvedProposalIds).toEqual([]);
  });

  test("states, transitions and monetization facts are all citable evidence", async () => {
    const result = await recommend(
      SNAPSHOT,
      new ScriptedProposer([proposal("a", { evidenceIds: ["chat", "t-send", "m-quota"] })]),
      new ScriptedJudge(() => assessment(GOOD)),
    );
    expect(result.approvedProposalIds).toEqual(["a"]);
  });

  test("a revision keeps the candidate ID and advances the revision, whatever the model returns", async () => {
    const judge = new ScriptedJudge((item) => assessment(item.revision === 0 ? WEAK : GOOD));
    for (const reviseTo of [(item: Proposal) => ({ ...item, id: "b", revision: 7 }), (item: Proposal) => ({ ...item })]) {
      const result = await recommend(SNAPSHOT, new ScriptedProposer([proposal("a")], reviseTo), judge);
      expect(result.proposals.map((item) => `${item.id}@${item.revision}`)).toEqual(["a@0", "a@1"]);
      expect(result.approvedProposalIds).toEqual(["a"]);
    }
  });

  test("code assigns initial identity: at most five candidates, unique IDs, revision zero", async () => {
    const judge = new ScriptedJudge(() => assessment(GOOD));
    const six = ["a", "b", "c", "d", "e", "f"].map((id) => proposal(id));
    expect((await recommend(SNAPSHOT, new ScriptedProposer(six), judge)).approvedProposalIds).toEqual(["a", "b", "c", "d", "e"]);
    const duplicates = [proposal("a"), proposal("a"), proposal("a-2"), proposal("x", { revision: 1 })];
    const result = await recommend(SNAPSHOT, new ScriptedProposer(duplicates), judge);
    expect(result.proposals.map((item) => `${item.id}@${item.revision}`)).toEqual(["a@0", "a-2@0", "a-2-2@0", "x@0"]);
  });

  test("an invalid product model is refused before any model call", async () => {
    const proposer = new ScriptedProposer([proposal("a")]);
    const judge = new ScriptedJudge(() => assessment(GOOD));
    const broken = { ...SNAPSHOT, states: SNAPSHOT.states.map((item) => ({ ...item, evidence: [] })) };
    await expect(recommend(broken, proposer, judge)).rejects.toThrow();
    expect(judge.seen).toHaveLength(0);
  });
});

test("a model-backed round shares user tasks, value anchors, pricing, and flows with proposer and judge", async () => {
  const root = mkdtempSync(join(tmpdir(), "appraise-recommend-"));
  try {
    const runDirectory = join(root, "runs", "app", "run-1");
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(join(runDirectory, "product-model.json"), JSON.stringify(SNAPSHOT));
    const contextPath = join(root, "context.txt");
    writeFileSync(contextPath, "Operator says subscriptions are the primary revenue source.");
    const model = new ScriptedModel([
      [assistantMessage(JSON.stringify({ proposals: [proposal("a")] }))],
      [assistantMessage(JSON.stringify(assessment(GOOD)))],
    ]);
    const output = await runRecommend({ projectRoot: root, appKey: "app", runId: "run-1", contextPath, model });
    expect(output).toMatchObject({ proposals: 1, approved: 1 });
    expect(model.calls).toHaveLength(2);
    for (const call of model.calls) {
      const input = JSON.stringify(call.request.input);
      expect(input).toContain("m-quota");
      expect(input).toContain("t-send");
      expect(input).toContain("subscriptions are the primary revenue source");
    }
    const appContext = JSON.parse(readFileSync(join(output.outputDirectory, "app-context.json"), "utf8"));
    expect(appContext.states.map((item: { id: string }) => item.id)).toEqual(["chat", "quota_exhausted"]);
    expect(appContext.states[1].monetization[0]).toMatchObject({ id: "m-quota", basis: "observed" });
    expect(appContext.transitions.map((item: { id: string }) => item.id)).toEqual(["t-send"]);
    expect(appContext.supplementalContext).toEqual({ source: contextPath, text: "Operator says subscriptions are the primary revenue source." });
    // Each fact and transition is sent once, not once per derived view.
    expect(JSON.stringify(appContext).split("m-quota")).toHaveLength(2);
    expect(JSON.stringify(appContext).split("t-send")).toHaveLength(2);
    const judgments = JSON.parse(readFileSync(join(output.outputDirectory, "judgments.json"), "utf8"));
    expect(judgments.approvedProposalIds).toEqual(["a"]);
    const manifest = JSON.parse(readFileSync(join(output.outputDirectory, "manifest.json"), "utf8"));
    expect(manifest.usage.map((entry: { stage: string }) => entry.stage)).toEqual(["propose", "judge"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
