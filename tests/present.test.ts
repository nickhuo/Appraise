import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { MockManifest } from "../src/domain/mock.ts";
import type { ProductModel } from "../src/domain/product-model.ts";
import type { Judgment, Proposal } from "../src/domain/proposal.ts";
import { runPresent } from "../src/present/present.ts";

test("present shows only final approved revisions and keeps observed evidence distinct from proposed screens", async () => {
  const root = mkdtempSync(join(tmpdir(), "appraise-present-"));
  try {
    const runDirectory = join(root, "runs", "app", "run-1");
    const recommendationDirectory = join(runDirectory, "recommend", "review-1");
    const mockDirectory = join(runDirectory, "mock", "mock-1");
    mkdirSync(join(runDirectory, "screens"), { recursive: true });
    mkdirSync(recommendationDirectory, { recursive: true });
    mkdirSync(mockDirectory, { recursive: true });
    const screenshot = "runs/app/run-1/screens/0.png";
    const elementTree = "runs/app/run-1/screens/0.elements.json";
    const snapshot: ProductModel = {
      runId: "run-1", runStatus: "complete", stopReason: "done",
      app: { key: "app", packageId: "com.example", version: null },
      states: [{
        id: "observed-limit", screen: "Chat limit", variant: "default", summary: "Limit reached",
        isCore: true, isModal: false, fingerprint: "limit", viewport: { width: 1, height: 1 },
        elements: [], visual: { layout: "", colors: [], typography: "", copy: [], assets: [] },
        groups: [], evidence: [{ step: 0, screenshot, elementTree }], monetization: [],
      }],
      transitions: [],
    };
    const proposal: Proposal = {
      id: "approved", revision: 1, title: "Reward <script>alert(1)</script>",
      opportunityType: "product_change", entryStateId: "observed-limit", evidenceIds: ["observed-limit"],
      trigger: "At the limit. This explanation is intentionally omitted from the slide.", userNeed: "Continue", eligibility: "Free users",
      productChange: "Add a choice", reward: "One extra turn", optIn: "Watch ad",
      fulfillment: "Grant the turn after completion", declinePath: "Return to limit",
      failurePath: "Return without reward", businessImpact: "Test subscription impact",
      validationPlan: "Measure reward use", assumptions: ["Reward size is untested"],
    };
    const rejected = { ...proposal, id: "rejected", title: "Rejected concept", revision: 0 };
    const scores = { userValue: 4, contextFit: 4, businessFit: 4, feasibility: 4, evidence: 4 };
    const judgments: Judgment[] = [
      { proposalId: "approved", revision: 0, decision: "revise", scores, hardFailures: [], rationale: "", feedback: "" },
      { proposalId: "approved", revision: 1, decision: "pass", scores, hardFailures: [], rationale: "", feedback: "" },
      { proposalId: "rejected", revision: 0, decision: "reject", scores, hardFailures: ["No value"], rationale: "", feedback: "" },
    ];
    const mock: MockManifest = {
      version: 3, runId: "run-1", inputHash: "mock-1", app: "app", runStatus: "complete", stopReason: "done",
      initialStep: 0, states: [{ id: "observed-limit", screen: "Chat limit", variant: "default", summary: "", observationSteps: [0], unexploredGroups: [] }],
      observations: [{ step: 0, stateId: "observed-limit", viewport: { width: 1, height: 1 }, evidence: { screenshot, elementTree } }],
      transitions: [],
    };
    writeFileSync(join(runDirectory, "product-model.json"), JSON.stringify(snapshot));
    writeFileSync(join(root, screenshot), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9l8GQAAAAASUVORK5CYII=", "base64"));
    writeFileSync(join(root, elementTree), "[]");
    writeFileSync(join(recommendationDirectory, "proposals.json"), JSON.stringify({ runId: "run-1", proposals: [{ ...proposal, revision: 0 }, proposal, rejected] }));
    writeFileSync(join(recommendationDirectory, "judgments.json"), JSON.stringify({ runId: "run-1", judgments, approvedProposalIds: ["approved"] }));
    writeFileSync(join(mockDirectory, "manifest.json"), JSON.stringify(mock));
    writeFileSync(join(mockDirectory, "index.html"), "<html></html>");

    const presented = await runPresent({ projectRoot: root, appKey: "app", runId: "run-1", recommendationDirectory, mockDirectory });
    const html = readFileSync(join(presented.outputDirectory, "index.html"), "utf8");
    expect(presented).toMatchObject({ slides: 3, approved: 1 });
    expect(html).toContain("Proposal approved · revision 1");
    expect(html).toContain("Reward &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("Rejected concept");
    expect(html).toContain("Observed screen: Chat limit · evidence: observed-limit");
    expect(html).not.toContain("intentionally omitted");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("Open interactive mock");
    const manifest = JSON.parse(readFileSync(join(presented.outputDirectory, "manifest.json"), "utf8"));
    expect(manifest.sources).toEqual([{ proposalId: "approved", revision: 1, entryStateId: "observed-limit", resumeStateId: "observed-limit", screenshot }]);

    const second = { ...proposal, id: "also-approved", title: "Another concept", revision: 0 };
    writeFileSync(join(recommendationDirectory, "proposals.json"), JSON.stringify({
      runId: "run-1", proposals: [{ ...proposal, revision: 0 }, proposal, second, rejected],
    }));
    writeFileSync(join(recommendationDirectory, "judgments.json"), JSON.stringify({
      runId: "run-1", judgments: [...judgments, {
        proposalId: second.id, revision: 0, decision: "pass", scores, hardFailures: [], rationale: "", feedback: "",
      }], approvedProposalIds: ["approved", second.id],
    }));
    const selected = await runPresent({ projectRoot: root, appKey: "app", runId: "run-1",
      recommendationDirectory, mockDirectory, proposalId: "approved" });
    expect(selected).toMatchObject({ slides: 3, approved: 1 });
    expect(readFileSync(join(selected.outputDirectory, "index.html"), "utf8")).not.toContain("Another concept");
    await expect(runPresent({ projectRoot: root, appKey: "app", runId: "run-1",
      recommendationDirectory, mockDirectory, proposalId: "rejected" })).rejects.toThrow("not approved");

    writeFileSync(join(recommendationDirectory, "judgments.json"), JSON.stringify({
      runId: "run-1", judgments: judgments.filter((judgment) => judgment.proposalId === "rejected"), approvedProposalIds: [],
    }));
    const empty = await runPresent({ projectRoot: root, appKey: "app", runId: "run-1", recommendationDirectory, mockDirectory });
    const emptyHtml = readFileSync(join(empty.outputDirectory, "index.html"), "utf8");
    expect(empty).toMatchObject({ slides: 1, approved: 0 });
    expect(emptyHtml).toContain("No approved recommendation");
    expect(emptyHtml).not.toContain("Reward &lt;script&gt;");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
