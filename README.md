# Appraise

Mobile app → product model → interactive mock → rewarded-ad proposals → slide flow. 

[System design](docs/system-design.md): primitives, architecture, key decisions and current limits.


| Stage     | Command     | Needs                        | Core Output                                       |
| --------- | ----------- | ---------------------------- | ------------------------------------------------- |
| Explore   | `explore`   | Android emulator, OpenAI key | `product-model.json`                              |
| Recreate  | `recreate`  | nothing                      | `mock/<hash>/index.html`                          |
| Recommend | `recommend` | OpenAI key                   | `recommend/<id>/proposals.json`, `judgments.json` |
| Present   | `present`   | nothing                      | `flows/<hash>/index.html`                         |


## Deliverables

The current implementation addresses the brief as follows. Artifact paths below are relative to `runs/<app>/<run-id>/`.


| Requested deliverable       | Implementation and evidence                                                                                                                                                                                                                                                                                                                                                                                   | Remaining work                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Code                        | `bun explore`, `bun recreate`, `bun recommend` (proposer + judge), and `bun present`. Source: [explore](src/explore/), [recreate](src/recreate/), [recommend](src/recommend/), [present](src/present/). Explore and Recommend use `gpt-6-sol` by default and `OPENAI_API_KEY`; Explore also needs an Android emulator and starts a local Appium server. Recreate and Present run locally without model calls. | No separate QA-loop command.                                                                                                       |
| Product model (Goal 1)      | `product-model.json` records observed states, actions, transitions, screenshot evidence, discovered monetization facts, and unfinished or blocked entrances. The sample coverage is listed below.                                                                                                                                                                                                             | Coverage is partial; each run exports its own model. Cross-run merging and resume are not implemented in the current explorer.     |
| Mock + QA evidence (Goal 2) | `mock/<hash>/index.html` replays the original screenshots and recorded interactions; `manifest.json` records their sources. Recreate validates evidence paths, image dimensions and transition references. See [Recreate design](docs/recreate-flow.md).                                                                                                                                                      | This is screenshot replay. A generated UI, visual diff reports, and an autonomous compare-and-correct QA loop are not implemented. |
| Rewarded flows (Goal 4)     | `recommend/<id>/proposals.json` and `judgments.json` retain candidates, revisions, scores, reasoning and rejections. `flows/<hash>/index.html` presents approved proposals; its `manifest.json` records the inputs.                                                                                                                                                                                           | Proposed ads and rewards are illustrated, not executed in the real app.                                                            |
| Trajectory                  | `explore.log` records decisions, actions and failures; `graph.json` retains observations and model usage; `captures/` contains screenshots, marked screenshots, page source and element lists. Recommendation manifests record model usage. [Design notes](docs/design.md) and [ablation notes](docs/function-ablation.md) explain implementation changes.                                                    | Manual setup includes installing apps and signing in. A consolidated record of all manual interventions is not yet provided.       |
| 10–15 minute recording      | Not yet included.                                                                                                                                                                                                                                                                                                                                                                                             | Record the end-to-end walkthrough, including architecture, trade-offs, partial coverage, the missing QA loop, and next steps.      |


### Sample coverage

These are the latest local sample models inspected on September 27, 2026. Their run directories also contain the generated mocks, recommendations and flows. `runs/` is gitignored; include the selected directories when sharing a delivery, or regenerate them with the commands below.


| App     | Product model                                                                 | What the run captured                                                                               | Stop condition                                                           |
| ------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Janitor | [Model](runs/janitorai/v2-2026-09-27T14-14-59-732Z-e80625/product-model.json) | 11 states, 23 transitions: character discovery, detail, chat, persona selection and model settings. | Action budget reached; some steps also timed out.                        |
| Luzia   | [Model](runs/luzia/v2-2026-09-27T16-46-24-458Z-3fc81d/product-model.json)     | 9 states, 20 transitions: chat, routines and the Luzia Plus paywall.                                | Media prerequisites and navigation/no-effect failures left work blocked. |
| AOL     | [Model](runs/aol/v2-2026-09-27T16-19-26-720Z-c5c396/product-model.json)       | 5 states, 9 transitions: home, articles, search and sign-in.                                        | Login, permission and unavailable-element blockers.                      |
| OOC     | No model included.                                                            | Previous emulator attempts ended when the app closed itself.                                        | Core experience not explored.                                            |


## Setup

Requirements: [Bun](https://bun.sh), Node.js compatible with the installed Appium 3 package (`^20.19.0`, `^22.12.0`, or `>=24.0.0`), npm 10+, the Android SDK and Emulator installed through Android Studio, and an OpenAI API key.

### Install the Android SDK and Emulator

1. Download [Android Studio from Google](https://developer.android.com/studio) and complete its setup wizard.
2. Open [SDK Manager](https://developer.android.com/studio/intro/update#sdk-manager). Install an Android SDK Platform; under **SDK Tools**, install **Android SDK Platform-Tools**, **Android SDK Build-Tools**, **Android SDK Command-line Tools**, and **Android Emulator**. The emulator is downloaded here as an SDK component.
3. Open **Device Manager** (or **More Actions → Virtual Device Manager** on the welcome screen). Create a phone using a hardware profile with the **Google Play** logo and download a compatible Google Play system image. Start the device with its play button. See Google's [virtual-device setup guide](https://developer.android.com/studio/run/managing-avds).
4. Find **Android SDK Location** in SDK Manager. The explorer defaults to `~/Library/Android/sdk` on macOS; if your location differs, set `ANDROID_HOME` to that directory in `.env` or your shell.

### Install project dependencies

```bash
bun install
APPIUM_HOME=.appium bunx appium driver install uiautomator2   # once
cp .env.example .env                                          # then set OPENAI_API_KEY
```

### Install an example app

On the running emulator, open Google Play, sign in, and install the target app from its listing. These are the four mappings in [apps.json](apps.json):

## Run end to end

Smoke test, all four stages in one command with a 5-action explore. It prints each stage's artifacts and checkpoints: the stop reason, states and entrance status, monetization found, each candidate's verdict and scores, and the slide count.

```bash
bun e2e --app luzia
```

Or run the stages one by one:

The example uses Luzia. Each command prints JSON; copy the `runId` and `outputDirectory` values into the next command.

**1. Explore** (about 20 minutes for 30 actions). Explore starts its own Appium server.

Explore operates the real app to map its core user journeys. It observes screenshots and the accessibility tree, asks the model to select a small set of useful actions, executes one, then observes the result. It follows a branch until there is no pending core action, then returns to another branch. Loading screens are waited out. The run stops when the discovered queue is exhausted, the action budget is reached, or the remaining work is blocked.

```bash
bun explore --app luzia --max-actions 30
```

The core output is `runs/luzia/<run-id>/product-model.json`: a structured graph of the observed app experience. A **state** describes a screen and its condition; a **transition** records an action and the state it reached. Each state carries screenshot and element-tree evidence, a summary, and the status of its selected entrances. The model also records observed monetization facts and why exploration stopped. Recreate, Recommend and Present consume this file. It describes the paths actually observed, not a guarantee that the entire app was covered.

`graph.json` retains the full exploration record, `captures/` holds the evidence, and `explore.log` records step-by-step progress. To browse the graph visually, run Recreate below. The current explorer uses tap, type and Back actions, and scrolls when necessary to reveal a target. It marks login, payment, account-change, media and permission prerequisites as blocked; external-app handoffs are recorded before returning. Continuing through required media or permission steps is not yet supported in this implementation.

**2. Recreate** (seconds, no model calls):

```bash
bun recreate --app luzia --run <run-id>
```

Open `mock/<hash>/index.html`. The left side is the explored state tree. Each screenshot marks its entrances: green ones were executed, blue ones are pending, and amber ones could not be done (blocked, unreachable, no effect). Tap a green box, or its `→` destination, to follow the recorded transition. Click an entrance name to show where it is. Scroll with the mouse wheel, a vertical drag, or the ↑/↓ cues.

**3. Recommend** (about 1 minute):

```bash
bun recommend --app luzia --run <run-id>
```

A proposer drafts candidates from the product model, and a separate judge scores each one. A weak candidate can be revised once. The output lists the proposals and the verdicts, including rejected ones.

If the app's prices were never observed, pass them as `--context <file>`, for example copied from the store listing.

**4. Present** (seconds):

```bash
bun present --app luzia --run <run-id> \
  --recommend-dir <recommend outputDirectory> --mock-dir <recreate outputDirectory>
```

Open `flows/<hash>/index.html` and use ← / → to move between slides. Each approved proposal gets three slides: the existing state and the proposed mechanic, the choice and the ad, then the reward and the return to the task. The slides draw the proposal over the observed screens.

## Options

- `--package <id>`: an app that is not in `apps.json`.
- `--device <id>`: pick a device when more than one is online.
- `--model <id>` or `OPENAI_MODEL`: change the model, for `explore` and `recommend`. The default is `gpt-6-sol`.

## Checks

```bash
bun run check
bun test
```
