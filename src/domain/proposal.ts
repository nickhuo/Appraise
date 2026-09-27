/** Short on-screen copy for each proposed step, written by the proposer and reviewed with the proposal. */
export type ProposalScreens = {
  entry: { title: string; detail: string };
  choice: { title: string; detail: string; accept: string; decline: string };
  inUse: { request: string; response: string; badge: string };
  after: { title: string; detail: string };
};

export type Proposal = {
  id: string;
  revision: number;
  title: string;
  opportunityType: "existing" | "product_change";
  entryStateId: string;
  // Where the user continues after the reward; absent in proposals written before the field existed.
  resumeStateId?: string;
  evidenceIds: string[];
  trigger: string;
  userNeed: string;
  eligibility: string;
  productChange: string;
  reward: string;
  optIn: string;
  fulfillment: string;
  declinePath: string;
  failurePath: string;
  businessImpact: string;
  validationPlan: string;
  assumptions: string[];
  // Absent in proposals written before on-screen copy was part of a proposal.
  screens?: ProposalScreens;
};

export type JudgmentScores = {
  userValue: number;
  contextFit: number;
  businessFit: number;
  feasibility: number;
  evidence: number;
};

export type Judgment = {
  proposalId: string;
  revision: number;
  scores: JudgmentScores;
  hardFailures: string[];
  rationale: string;
  feedback: string;
  decision: "pass" | "revise" | "reject";
};

export type Recommendation = {
  runId: string;
  proposals: Proposal[];
  judgments: Judgment[];
  approvedProposalIds: string[];
};
