# Observation token experiment

Measured on 2026-09-27 (America/Los_Angeles), using Mobile MCP 1.0.5, mobilecli 1.0.13, Appium 3.8.0 and UiAutomator2 8.7.0. Local artifacts are in `data/tree-benchmark/`; no production behavior was changed.

## Results

Text payload tokens, using tiktoken 0.14.0 with `o200k_base`:

| App / current page | Appium XML | Mobile MCP text | Mobile MCP without status bar | Appium actions + visible text |
| --- | ---: | ---: | ---: | ---: |
| AOL | 27,796 | 3,652 | 2,964 | 1,900 |
| Janitor AI | 125,485 | 2,904 | 2,216 | 1,506 |
| Luzia | 7,457 | 1,231 | 543 | 249 |

Each valid pair was captured sequentially: Appium, Mobile MCP, Appium. Visible application node keys (class, resource ID, bounds, text and content description) matched before and after. XML strings differed because other attributes can change between sessions. The Mobile MCP payload contained every distinct visible Appium text/content-description/hint string in these three samples: 36/36, 38/38 and 11/11 respectively. This checks string retention, not semantic equivalence or task success.

OOC was captured but excluded from the paired comparison: it displayed an emulator-detection warning, and its UI changed between reads. Its raw artifacts and failed stability checks remain in `results.json`.

Filtering the status bar removes 25 nodes per valid sample and saves 688 tokens: **18.8%, 23.7%, and 55.9%** of the Mobile MCP text respectively. It finds `com.android.systemui:id/status_bar`, then removes nodes whose rectangles are wholly inside that container. It preserves the original refs. All 85 application label occurrences remain after filtering. This is post-processing of Mobile MCP's output, not a built-in tool option. The installed tool exposes `device` and `format`, not a package/status-bar filter.

Prefer the actual container bounds to a hardcoded top strip. With a tree that exposes package ownership, removing the `com.android.systemui` subtree is more explicit. Do not remove all `View`/`FrameLayout` nodes: they can be application controls. The geometric rule should be checked separately for landscape, multi-window, overlays and edge-to-edge layouts; this experiment only tests the current portrait emulator.

## Clickable-only ablation

The offline corpus contains **152 distinct XML captures** from 9 existing run graphs, deduplicated by SHA-256 of the XML. These are not 152 independent screens; repeated app states and multiple Luzia runs remain. The one archived OOC warning is included in this offline ablation, unlike the unstable live OOC pair.

| Representation | Median text tokens per capture |
| --- | ---: |
| Raw Appium XML | 9,002.5 |
| Current project's model-facing element list | 99 |
| Visible clickable nodes, with descendant labels and bounds | 216 |
| Visible actions + all distinct visible labels | 318 |

Even with non-clickable descendant labels merged into clickable parents, clickable-only loses **692 of 2,383 distinct-per-capture labels (29.0%)**, across **119/152 captures**. It also drops 167 non-clickable scroll-container occurrences. This corpus loses no inputs under the clickable-only test; that does not establish that all inputs are clickable in other apps.

Concrete lost evidence:

- `runs/janitorai/v2-2026-09-27T14-14-59-732Z-e80625/captures/050.xml`: `$12.99`.
- `runs/luzia/v2-2026-09-27T16-46-24-458Z-3fc81d/captures/011.xml`: the daily image limit and upgrade message.

The actions + text variant includes clickable, checkable, editable/EditText, scrollable and long-clickable nodes, retaining selected/focused/checked/disabled states and bounds. It adds remaining visible text, content descriptions and hints as context. It is a benchmark representation, not an integrated production observation format; it does not preserve every hierarchy/label association or resource ID.

## Interpretation and limits

- Mobile MCP's default text is much smaller than raw Appium XML. Appium can also be serialized compactly; the transport/backend alone does not determine token cost.
- Appium uses the project's `allowInvisibleElements=true` setting and retains extra attributes/off-screen content in XML. Mobile MCP has its own filtering. These are real configured payload comparisons, not equal-information source trees.
- The current project already sends a sampled, compact action list and a marked screenshot, rather than XML. Its 99-token median excludes the screenshot, instructions and known-screen context; compare it only as the text portion of the observation.
- Counts exclude MCP/HTTP envelopes, tool schemas, screenshots, model output and retries. `o200k_base` is a fixed measurement encoding, not a claim about a particular model's billed tokens. No model calls were made.
- Mobile MCP was invoked through the installed `MobileDevice.getElementsOnScreen()` and `formatElements()` functions, exactly the backend and formatter used by `mobile_list_elements_on_screen`. The MCP transport envelope was not measured.
- Acquisition durations are diagnostic only: `beforeMs` includes the project's settling loop, `mobileMs` is one Mobile MCP read, and `afterMs` is one Appium read. They are not comparable latency benchmarks.
- Three stable live pages support a pilot result, not a general backend ranking. Task-level efficiency still needs fixed tasks, the same model/screenshots, success criteria, and total tokens including retries and recovery.

For this project, retain Appium and optimize the model-facing representation. A useful default is actions plus nearby labels, values, prices, quota/error messages and scroll context; request a richer tree or screenshot when needed. Removing status-bar containers is an inexpensive first step for Mobile MCP as well.

## Reproduce

Use an idle emulator: the existing `AndroidDevice.connect()` stops Mobile MCP's device server because both tools need the same Android UiAutomation connection. The script launches apps in `apps.json` without clearing their data. It changes the foreground app.

```sh
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"
export MOBILECLI_PATH="$HOME/.bun/install/cache/@mobilenext/mobilecli-darwin-arm64@1.0.13@@@1/mobilecli-darwin-arm64"

# Use adb devices and mobilecli devices to obtain the two different identifiers.
bun run experiments/tree-benchmark/capture.ts \
  --mobile-mcp "$HOME/.bun/install/cache/@mobilenext/mobile-mcp@1.0.5@@@1" \
  --device emulator-5554 --mobile-device Pixel_8

uv run experiments/tree-benchmark/analyze.py
```

The package/binary paths above match the measured local installation. Change them for another installation. Raw payloads, filtered examples, hashes, missing strings and detailed counts are saved under `data/tree-benchmark/`. Captures can contain app content and are ignored by Git.

Verification: the capture script ran on all four configured apps; the analysis completed on 152 unique captures. `bun run check` and all 15 existing `bun test` tests passed. The experiment's TypeScript passed a separate strict `tsc` check and the Python script passed `py_compile`. No unit tests were added, per the project-local `AGENT.md`.

Implementation references: [Mobile MCP formatter](https://github.com/mobile-next/mobile-mcp/blob/main/src/format-elements.ts), [Mobile MCP backend](https://github.com/mobile-next/mobile-mcp/blob/main/src/mobile-device.ts), `src/explore/device.ts`, `src/explore/page.ts`, and `src/explore/analyst.ts`. The measurements use the locally installed pinned versions, not GitHub main.
