import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type { Analysis } from "../../src/explore/analyst.ts";
import { type Graph, routeToScreen, toEntrances, toProductModel } from "../../src/explore/graph.ts";
import { isSameState, type PageElement } from "../../src/explore/page.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { root: { type: "string", default: "." }, compare: { type: "string" } },
});
const root = resolve(values.root!);
const paths = (await Array.fromAsync(new Bun.Glob("runs/*/*/graph.json").scan({ cwd: root }))).sort();
assert(paths.length > 0, "No archived graphs found; pass --root with a project containing runs");

const hashes = { exports: createHash("sha256"), routes: createHash("sha256"), entrances: createHash("sha256") };
const corpus: Array<{ path: string; sha256: string }> = [];
const totals = {
  graphs: paths.length, states: 0, captures: 0, routes: 0, entranceProbes: 0,
  serializedBytes: 0, withoutStateElementsBytes: 0,
  namesLost: 0, matchingPairs: 0, fuzzyMatchesLost: 0,
};
const nameExamples: Array<{ path: string; step: number; number: number; name: string }> = [];
const matchExamples: Array<{ path: string; state: string; step: number }> = [];

for (const path of paths) {
  const bytes = await readFile(resolve(root, path));
  corpus.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  const graph = JSON.parse(bytes.toString()) as Graph;
  const stripped = structuredClone(graph);
  for (const state of stripped.states) delete (state as typeof state & { elements?: PageElement[] }).elements;
  totals.states += graph.states.length;
  totals.captures += Object.keys(graph.captures).length;
  totals.serializedBytes += Buffer.byteLength(JSON.stringify(graph, null, 1));
  totals.withoutStateElementsBytes += Buffer.byteLength(JSON.stringify(stripped, null, 1));

  const snapshot = toProductModel(graph);
  assert.deepStrictEqual(toProductModel(stripped), snapshot, `${path}: product model changed`);
  hashes.exports.update(JSON.stringify(snapshot));
  for (const state of graph.states) {
    for (const screen of graph.screens) {
      const route = routeToScreen(graph, state.id, screen.id);
      assert.deepStrictEqual(routeToScreen(stripped, state.id, screen.id), route, `${path}: route changed`);
      hashes.routes.update(JSON.stringify(route));
      totals.routes++;
    }

    // Archived names reconstruct input for entrance generation, not the original model response.
    const named = (state as typeof state & { elements?: PageElement[] }).elements;
    assert(named, `${path}: state ${state.id} lacks the archived elements required by this experiment`);
    const capture = graph.captures[state.steps[0]!]!;
    const analysis: Analysis = {
      existingScreenId: state.screenId, screenName: "", screenDescription: "",
      variantName: state.variant, isLoading: false, summary: state.summary,
      elementNames: named.filter((element) => element.name).map(({ number, name }) => ({ number, name })),
      monetization: [],
      entrances: capture.elements.map((element) => ({
        number: element.number, text: element.kind === "type" ? "sample" : null,
        submit: false, blockedReason: null, reason: "Offline entrance probe",
      })),
    };
    const entrances = toEntrances(capture, analysis, 0);
    const withoutNames = toEntrances(capture, { ...analysis, elementNames: [] }, 0);
    hashes.entrances.update(JSON.stringify(entrances));
    totals.entranceProbes += entrances.length;
    for (let index = 0; index < entrances.length; index++) {
      const entrance = entrances[index]!;
      if (entrance.name === withoutNames[index]!.name) continue;
      totals.namesLost++;
      if (nameExamples.length < 5) nameExamples.push({ path, step: capture.step, number: capture.elements[index]!.number, name: entrance.name });
    }
    for (const evidence of Object.values(graph.captures)) {
      if (state.activity !== evidence.foreground.activity) continue;
      totals.matchingPairs++;
      if (!isSameState(state, evidence) || state.signature === evidence.signature) continue;
      totals.fuzzyMatchesLost++;
      if (matchExamples.length < 5) matchExamples.push({ path, state: state.id, step: evidence.step });
    }
  }
}

const contracts = {
  exports: hashes.exports.digest("hex"), routes: hashes.routes.digest("hex"), entrances: hashes.entrances.digest("hex"),
};
if (values.compare) {
  const baseline = JSON.parse(await readFile(values.compare, "utf8")) as { corpus: typeof corpus; contracts: typeof contracts };
  assert.deepStrictEqual(corpus, baseline.corpus, "The comparison requires the same archived corpus");
  assert.deepStrictEqual(contracts, baseline.contracts, "Production behavior differs from the saved baseline");
}
const sourceHashes: Record<string, string> = {};
for (const path of ["src/explore/graph.ts", "src/explore/explore.ts"]) {
  sourceHashes[path] = createHash("sha256").update(await readFile(new URL(`../../${path}`, import.meta.url))).digest("hex");
}
console.log(JSON.stringify({
  sourceHashes, corpus, contracts, totals,
  savedBytes: totals.serializedBytes - totals.withoutStateElementsBytes,
  savedPercent: 100 * (1 - totals.withoutStateElementsBytes / totals.serializedBytes),
  nameExamples, matchExamples, baselineMatched: values.compare ? true : null,
}, null, 2));
