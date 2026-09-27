import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { MockManifest } from "./domain/mock.ts";
import type { Judgment, Proposal } from "./domain/proposal.ts";
import type { AndroidDevice } from "./explore/device.ts";
import { exploreApp } from "./explore/explore.ts";
import { runPresent } from "./present/present.ts";
import { runRecommend } from "./recommend/recommend.ts";
import { runRecreate } from "./recreate/recreate.ts";

/** Runs explore, recreate, recommend and present for one app, logging each stage's artifacts and key decisions. */
export async function runPipeline(options: {
  appKey: string;
  packageId: string;
  device: AndroidDevice;
  projectRoot: string;
  maxActions: number;
  model?: string;
  log: (line: string) => void;
}): Promise<{ runId: string; mock: string; slides: string }> {
  const { appKey, projectRoot, log } = options;
  const path = (absolute: string) => relative(projectRoot, absolute);
  const readJson = async <T>(file: string) => JSON.parse(await readFile(file, "utf8")) as T;
  const stage = (index: number, name: string) => log(`\n━━ ${index}/4 ${name} ${"━".repeat(Math.max(0, 50 - name.length))}`);

  stage(1, "Explore");
  const graph = await exploreApp({ ...options, log: (line) => log(`  ${line}`) });
  const runDirectory = join("runs", appKey, graph.runId);
  const entrances = graph.states.flatMap((state) => state.entrances);
  const count = (status: string) => entrances.filter((entrance) => entrance.status === status).length;
  log(`  artifacts  ${runDirectory}/product-model.json · graph.json · explore.log · captures/ (${Object.keys(graph.captures).length} observations)`);
  log(`  checkpoint stopped ${graph.status}: ${graph.reason} · ${graph.budget.used}/${graph.budget.max} actions`);
  log(`  checkpoint ${graph.states.length} states, ${graph.edges.length} transitions · entrances: ${count("explored")} done, ${count("pending")} pending, ` +
    `${entrances.length - count("explored") - count("pending")} not done`);
  for (const state of graph.states) {
    const screen = graph.screens.find((item) => item.id === state.screenId)!.name;
    log(`             ${state.id} ${screen}/${state.variant}: ${state.entrances.filter((entrance) => entrance.status === "explored").length}/${state.entrances.length} done`);
  }
  const monetization = graph.states.flatMap((state) => state.monetization.map((fact) => `${state.id} ${fact.kind}: ${fact.description.slice(0, 80)}`));
  log(`  checkpoint monetization: ${monetization.length ? `${monetization.length} facts` : "none observed"}`);
  for (const fact of monetization) log(`             ${fact}`);

  stage(2, "Recreate");
  const mock = await runRecreate({ projectRoot, appKey, runId: graph.runId });
  const manifest = await readJson<MockManifest>(join(mock.outputDirectory, "manifest.json"));
  const mockEntrances = manifest.states.flatMap((state) => state.entrances);
  log(`  artifacts  ${path(mock.outputDirectory)}/index.html · manifest.json`);
  log(`  checkpoint ${mock.states} states, ${mock.actions} replayable actions, ${manifest.observations.length} frames` +
    ` (${manifest.observations.filter((observation) => observation.scroll).length} scrolled)`);
  log(`  checkpoint ${mockEntrances.filter((entrance) => entrance.bounds).length}/${mockEntrances.length} entrances drawn on a screenshot`);

  stage(3, "Recommend");
  const recommendation = await runRecommend({ projectRoot, appKey, runId: graph.runId, model: options.model });
  const { proposals } = await readJson<{ proposals: Proposal[] }>(join(recommendation.outputDirectory, "proposals.json"));
  const { judgments } = await readJson<{ judgments: Judgment[] }>(join(recommendation.outputDirectory, "judgments.json"));
  log(`  artifacts  ${path(recommendation.outputDirectory)}/proposals.json · judgments.json · app-context.json · manifest.json`);
  log(`  checkpoint ${recommendation.proposals} candidate${recommendation.proposals === 1 ? "" : "s"} judged (revisions included), ${recommendation.approved} approved`);
  for (const judgment of judgments) {
    const proposal = proposals.find((item) => item.id === judgment.proposalId && item.revision === judgment.revision)!;
    const { userValue, contextFit, businessFit, feasibility, evidence } = judgment.scores;
    log(`             ${judgment.decision.padEnd(6)} r${judgment.revision} ${proposal.title.slice(0, 70)}`);
    log(`                    value ${userValue} fit ${contextFit} business ${businessFit} feasible ${feasibility} evidence ${evidence}` +
      ` · offer on ${proposal.resumeStateId && proposal.resumeStateId !== proposal.entryStateId ? proposal.resumeStateId : proposal.entryStateId}`);
    const reason = judgment.hardFailures[0] ?? (judgment.decision === "pass" ? "" : judgment.feedback);
    if (reason) log(`                    why: ${reason.replace(/\s+/g, " ").slice(0, 110)}`);
  }

  stage(4, "Present");
  const slides = await runPresent({
    projectRoot, appKey, runId: graph.runId, recommendationDirectory: recommendation.outputDirectory, mockDirectory: mock.outputDirectory,
  });
  log(`  artifacts  ${path(slides.outputDirectory)}/index.html · manifest.json`);
  log(`  checkpoint ${slides.slides} slides for ${slides.approved} approved proposal${slides.approved === 1 ? "" : "s"}` +
    `${slides.approved ? "" : " (a single \"No approved recommendation\" slide)"}`);
  return { runId: graph.runId, mock: path(join(mock.outputDirectory, "index.html")), slides: path(join(slides.outputDirectory, "index.html")) };
}
