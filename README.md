# Appraise

Evaluating an app's monetization opportunities usually starts with walking through its user flows: what users want to accomplish, where they encounter limits, what paid plans offer, and what value an ad reward could provide. These observations often remain scattered across screenshots and notes, making them hard to trace to a final proposal.

Appraise connects this work for product, monetization, design and engineering teams. It explores an app, records its core journeys in a Product Model, generates an interactive replay, proposes rewarded-ad experiences that fit the product and business model, and presents approved proposals as slides.

https://github.com/user-attachments/assets/364c7662-0cf7-4533-b16e-38dc7eeacf36

## Deliverables

The current implementation addresses the brief as follows. Artifact paths below are relative to `runs/<app>/<run-id>/`.

- The [system design](docs/system-design.md) documents the architecture, trade-offs, current limits, and next steps.

- **Code:** `bun explore`, `bun recreate`, `bun recommend` (proposer + judge), and `bun present`. Source: [Explore](src/explore/), [Recreate](src/recreate/), [Recommend](src/recommend/), and [Present](src/present/). Explore and Recommend default to `gpt-6-sol` and require `OPENAI_API_KEY`. Explore also needs an Android emulator and starts a local Appium server. Recreate and Present run locally without model calls. 
- **Product model:** `product-model.json` records observed states, actions, transitions, screenshot evidence, monetization facts, and unfinished or blocked entrances. Coverage is partial, with one model per run. Cross-run merging and resume are not implemented.
- **Mock evidence:** `mock/<hash>/index.html` replays screenshots and recorded interactions; `manifest.json` records their sources. Recreate checks evidence paths, image dimensions, and transition references. Generated UI, visual diffs. 
- **Rewarded flows:** `recommend/<id>/proposals.json` and `judgments.json` retain candidates, revisions, scores, reasoning, and rejections. `flows/<hash>/index.html` presents approved proposals, with input references in its manifest. Ads and rewards are illustrated, not executed in the app.
- **Trajectory:** `explore.log` records decisions, actions, and failures; `graph.json` retains observations and model usage; `captures/` holds screenshots, page source, and element lists. Recommendation manifests record model usage.
- **Walkthrough recording:** [Watch the video](https://github.com/user-attachments/assets/364c7662-0cf7-4533-b16e-38dc7eeacf36). 


| App     | Product model                                                                 | Replay                                                                                                                                       | Proposal / Judge JSON                                                                                                                                                                                                                            |
| ------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Janitor | [Model](runs/janitorai/v2-2026-09-27T14-14-59-732Z-e80625/product-model.json) | [Replay](runs/janitorai/v2-2026-09-27T14-14-59-732Z-e80625/mock/6ea2d9b9582834412dc1d5b326dfb0fbf99fe98834f20483eed6572cd6f727b3/index.html) | [Proposal](runs/janitorai/v2-2026-09-27T14-14-59-732Z-e80625/recommend/2026-09-27T19-29-26-115Z-08d7de9b/proposals.json) · [Judge](runs/janitorai/v2-2026-09-27T14-14-59-732Z-e80625/recommend/2026-09-27T19-29-26-115Z-08d7de9b/judgments.json) |
| Luzia   | [Model](runs/luzia/2026-09-28T01-57-42-379Z-4a36ef/product-model.json)        | [Replay](runs/luzia/2026-09-28T01-57-42-379Z-4a36ef/mock/bc6b9877be43b8ddea20739b121c0efa134983035e2f4e7a4121339dffb7b898/index.html)        | [Proposal](runs/luzia/2026-09-28T01-57-42-379Z-4a36ef/recommend/2026-09-28T02-50-47-550Z-804a4d74/proposals.json) · [Judge](runs/luzia/2026-09-28T01-57-42-379Z-4a36ef/recommend/2026-09-28T02-50-47-550Z-804a4d74/judgments.json)               |
| AOL     | [Model](runs/aol/v2-2026-09-27T16-19-26-720Z-c5c396/product-model.json)       | [Replay](runs/aol/v2-2026-09-27T16-19-26-720Z-c5c396/mock/57e02e61d4cab06743439538d41f30e9b5cfeb915dcc467d15ad06c23fc9c5e8/index.html)       | [Proposal](runs/aol/v2-2026-09-27T16-19-26-720Z-c5c396/recommend/2026-09-27T19-31-29-100Z-ed71e93d/proposals.json) · [Judge](runs/aol/v2-2026-09-27T16-19-26-720Z-c5c396/recommend/2026-09-27T19-31-29-100Z-ed71e93d/judgments.json)             |
| OOC     | [Model](runs/ooc/2026-09-28T02-53-22-752Z-0901b2/product-model.json)          | Not generated                                                                                                                                | Not generated                                                                                                                                                                                                                                    |


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

**1. Explore** (about 20 minutes for 30 actions). Explore starts its own Appium server.

Explore operates the real app to map its core user journeys. It observes screenshots and the accessibility tree, asks the model to select a small set of useful actions, executes one, then observes the result. It follows a branch until there is no pending core action, then returns to another branch. Loading screens are waited out. The run stops when the discovered queue is exhausted, the action budget is reached, or the remaining work is blocked.

```bash
bun explore --app luzia --max-actions 30
```

**2. Recreate** (seconds, no model calls):

```bash
bun recreate --app luzia --run <run-id>
```

Open `mock/<hash>/index.html`. 

**3. Recommend** (about 1 minute):

```bash
bun recommend --app luzia --run <run-id>
```

A proposer drafts candidates from the product model, and a separate judge scores each one. A weak candidate can be revised once. 

If the app's prices were never observed, pass them as `--context <file>`, for example copied from the store listing.

**4. Present** (seconds):

```bash
bun present --app luzia --run <run-id> \
  --recommend-dir <recommend outputDirectory> --mock-dir <recreate outputDirectory>
```

slides

## Options

- `--package <id>`: an app that is not in `apps.json`.
- `--device <id>`: pick a device when more than one is online.
- `--model <id>` or `OPENAI_MODEL`: change the model, for `explore` and `recommend`. The default is `gpt-6-sol`.

## Checks

```bash
bun run check
bun test
```

