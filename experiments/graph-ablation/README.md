# Graph redundancy ablation

Measured offline on 2026-09-29 with Bun 1.3.14. The corpus contains 11 archived runs from AOL, Janitor AI, Luzia and OOC: 65 states and 180 captures. Runs and captures are not independent or deduplicated. None of these graphs contains a task-driven run.

## Results

| Ablation | Observation | Decision |
| --- | --- | --- |
| Remove `GraphState.elements` | All 11 product-model exports and 437 state-to-screen route queries remain identical. Serialized graphs shrink from 1,905,755 to 1,638,349 bytes, saving 267,406 bytes (14.03%). | Applied. |
| Remove analyst-provided element names | 182 of 871 entrance probes lose their display names, including `menu`, `weather settings` and `sign-up input`. | Retain name completion. |
| Replace approximate state matching with signature equality | No changed decisions among 1,560 same-Activity state/capture pairs. This corpus does not exercise the approximate-match branch. | Retain; insufficient evidence for removal. |

The byte comparison uses `JSON.stringify(graph, null, 1)`, matching Explore's serializer. Only `states[].elements` is removed; capture elements, screenshots, entrance locators and other graph fields remain. This measures final graph serialization size, not memory, runtime latency, cumulative writes, model tokens or task success.

## Production change

Repository call-site inspection found that `GraphState.elements` was written at state creation but never read by exploration, export, navigation or downstream stages. Controls already belong to `graph.captures[step].elements`.

Explore now omits the unused state-level copy. `toEntrances` resolves names for selected entrances directly and reuses the raw locator, removing `namedElements` and its full-array copies. Accessibility names still take precedence over analyst names; unnamed controls still fall back to `element N`. Purchase/account-change classification still uses the resolved display name.

The internal `graph.json` format consequently stops emitting `states[].elements`. Tools outside this repository that read that field must use the first referenced capture for raw controls and entrance names for selected controls. Analyst-provided names for unselected controls are no longer retained in a separate state-level list. Existing archived graphs remain readable; this experiment does not rewrite them. The `ProductModel` contract is unchanged by this cleanup.

## Verification

The baseline was captured from the initial working tree, including its existing uncommitted status-export changes. After the cleanup, hashes of all product-model exports, all route-query results and all 871 generated entrance records match the saved baseline exactly. Entrance records include keys, names, raw locators, input payloads, statuses and blocking reasons.

Entrance probes reconstruct analyst names from each archived state's first capture and named elements, then select every control. They exercise more controls than the recorded choices but are not original model responses or live device actions. The experiment does not exercise Appium, model output variation, recovery timing, task-driven exploration or browser interactions. Identical product-model exports establish identical downstream inputs, not an independently rerun live end-to-end result.

Commands and results:

- `bun run check`: passed.
- `bun test`: 15 passed, 0 failed, 66 assertions.
- `bun x tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --allowImportingTsExtensions --types bun experiments/graph-ablation/run.ts`: passed.
- `bun run experiments/graph-ablation/run.ts --compare data/graph-ablation/before.json`: passed; `baselineMatched: true`.

No unit tests were added, following the project-local `AGENT.md`. The experiment uses assertions and a before/after contract comparison. No additional production cleanup was justified by these measurements.

## Reproduce

Run from the project root with the archived, pre-cleanup `runs/*/*/graph.json` files available:

```sh
mkdir -p data/graph-ablation
bun run experiments/graph-ablation/run.ts > data/graph-ablation/current.json
```

For a fresh before/after comparison, run the script before the production edit and save its output as `before.json`, then run after the edit with the same corpus:

```sh
bun run experiments/graph-ablation/run.ts --compare data/graph-ablation/before.json \
  > data/graph-ablation/after.json
```

Use `--root <archive-root>` to read graphs from another project directory. The corpus must retain state-level elements so the name-removal comparison can reconstruct its inputs. Missing archives or state-level elements fail explicitly. The comparison also rejects a changed corpus rather than comparing unrelated runs.

The local [before](../../data/graph-ablation/before.json) and [after](../../data/graph-ablation/after.json) reports include each input's SHA-256, production source hashes, contract hashes, totals and concrete name-loss examples. `data/` and `runs/` are ignored by Git; these reports require the local artifacts.
