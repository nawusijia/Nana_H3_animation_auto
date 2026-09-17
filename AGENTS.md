# Nana H3 Animation Auto · Public Open-Source Agent Guide

> **THIS IS THE PUBLIC / OPEN-SOURCE STANDALONE EDITION.**
>
> Repository: `Nana_H3_animation_auto`
>
> It is **not** Nana's production Director Console and must never be treated as its workspace.

## 0. Hard isolation boundary

This repository is intentionally isolated from Nana's private production environment.

Agents working here MUST:

- read and write only this repository and the active H3 project path returned by `/api/agent/bootstrap`;
- store runtime data under this repository's configured `NANA_H3_DATA_DIR` (default `./data`);
- never search for, import from, edit, copy into, or use as a fallback any private Director Console checkout;
- never assume a machine-specific path from Nana's own computers;
- never add private API keys, private project assets, private URLs, Tailscale addresses, local usernames, or production-only paths to Git.

In particular, **do not access or modify any Director Console checkout outside this repository root**, including private production or legacy Director Console directories discovered elsewhere on the machine.

If a user also has Nana Director Console installed locally, treat the two products as unrelated workspaces unless the user explicitly asks for a one-time manual migration. Never publish or persist the location of that private checkout in this repository.

## 1. Default architecture: Agent-owned planning

The default mode is `agent_owned`.

The external local Agent owns:

`script analysis → Scene → asset planning → Shot → Sequence → final H3 Prompt → review/repair`

The H3 application owns:

`project files → deterministic validation → checkpoints → workspace projection → asset gate → H3 workflow routing → ComfyUI submission → same-Scene serial queue → relation-frame handoff → results`

MiniMax H3 / ComfyUI is an **execution engine only**. It does not decide screenplay structure, Shot design, Sequence grouping, or Prompt content.

**Do not ask the user for a GLM/OpenAI/Anthropic API key in the default mode. Do not call a network LLM provider from the app.** The model intelligence comes from the Agent that is already running this repository.

Legacy direct-provider compatibility exists only when the user explicitly sets:

```text
NANA_H3_AGENT_ONLY=false
```

That mode is not the default open-source workflow.

## 2. Agent takeover protocol

Every new planning run starts from the local H3 server:

```text
GET http://127.0.0.1:8797/api/agent/bootstrap
```

The bootstrap response is the only source for:

- active project id/name/root;
- current `pipeline.nextStage`;
- the stage contract;
- the context API;
- the completion API.

Never infer the current stage from chat history or old files.

For each stage:

1. `GET /api/agent/bootstrap`.
2. Read only `pipeline.nextStage`.
3. `GET stage.contextApi`.
4. Produce that stage's artifact.
5. Submit exactly through `stage.delivery.completionApi`:

```json
{
  "status": "completed",
  "artifact": {}
}
```

6. Read `/api/agent/bootstrap` again.
7. Repeat until `pipeline.nextStage` is `execution`.

Do not skip stages. Do not maintain a second UI-only state file. The server projects accepted artifacts into the H3 workspace.

## 3. Planning stages

### `outline`

Create natural Scene boundaries from the locked source script and an initial reusable asset catalog.

Return:

```json
{
  "outline": {
    "settings": {},
    "sceneOutlines": [
      { "id": "scene-1", "title": "...", "rawText": "...", "locationId": "..." }
    ]
  },
  "settings": {
    "overview": "...",
    "style": "...",
    "characters": [],
    "scenes": [],
    "assets": []
  }
}
```

A Scene is a time/space continuity boundary. Do not split merely because someone stands up, walks a few steps, or changes emotion.

### `assets`

Finalize the reusable asset records. Each record must have a stable `id` and useful design text/prompt, but the planning stage does **not** need an actual image file yet.

Use these buckets:

- `settings.characters[]` for people/characters;
- `settings.scenes[]` for scene reference assets;
- `settings.assets[]` for props/other physical assets.

Reference-image files are bound later in the execution UI or asset upload API.

### `shots`

Draw the script into ordered atomic visual Shots.

Each Shot should include at least:

```json
{
  "id": "shot-1",
  "sceneId": "scene-1",
  "order": 0,
  "durationSeconds": 3,
  "sourceText": "locked source text / action",
  "direction": {
    "framing": "...",
    "camera": "...",
    "subject": "...",
    "action": "...",
    "endState": "..."
  },
  "speech": [],
  "characterIds": [],
  "assetIds": []
}
```

Shot duration is a natural candidate duration. It does not need to be 5–15 seconds; the H3 limit applies to Sequence.

Dialogue must preserve the source wording and order. Do not split a normal sentence at an unnatural grammatical point merely to create a cut.

### `sequences`

Assemble approved Shots into H3 execution windows.

Every Sequence:

- is an integer `5–15s`;
- stays inside one Scene;
- preserves Shot order;
- contains every approved Shot exactly once across the project;
- does not rewrite Shot action/dialogue/outcome.

Return:

```json
{
  "sequences": [
    {
      "id": "sequence-1",
      "sceneId": "scene-1",
      "order": 0,
      "title": "...",
      "shotIds": ["shot-1", "shot-2"],
      "durationSeconds": 12,
      "assetIds": []
    }
  ]
}
```

### `prompts`

Compile one final executable MiniMax H3 Prompt for every Sequence.

Return maps keyed by Sequence id:

```json
{
  "prompts": { "sequence-1": "..." },
  "directorReads": { "sequence-1": {} },
  "generationAudits": { "sequence-1": {} },
  "sequenceEndStates": { "sequence-1": "..." }
}
```

`directorReads[sequenceId]` must contain all 10 fields:

- `dramaticFunction`
- `turn`
- `viewerPOV`
- `relationshipShift`
- `objective`
- `obstacle`
- `visibleBehavior`
- `visualIntention`
- `cameraPrinciple`
- `genreRefusal`

`generationAudits[sequenceId]` must contain:

- `appearanceCheck: "pass"`
- `assetBoundaryCheck: "pass"`
- `timelineCheck: "pass"`
- `dialogueCheck: "pass"`
- `transitionCheck: "pass"`
- optional `notes`

The final Prompt must contain these exact headings:

```text
【生成规格】
【导演原则】
【场景设定】
【声音设定】
【氛围与画质】
【画面内容】
【生成限制】
```

Inside `【画面内容】`, Shot headers use exactly:

```text
shot1(0s-3s)
...
shot2(3s-7s)
...
```

Rules:

- integer seconds only;
- timeline starts at 0, is continuous, and ends exactly at the Sequence duration;
- each Shot header occupies its own line;
- preserve approved dialogue exactly once and in source order;
- do not invent dialogue/narration;
- do not repeat character/asset appearance that is already controlled by reference images;
- do not write post-production fade/flash/dissolve transitions into generation prompts;
- do not include asset IDs/upload instructions in the visible video prompt;
- first frame starts directly on valid footage and last frame ends on a valid visible state;
- `sequenceEndStates` describes the last visible state for same-Scene continuity.

### `reviewer`

Review the entire plan against the source and current workflow. Fix the relevant upstream stage before passing if necessary.

Only return pass when the plan is internally consistent:

```json
{
  "status": "pass",
  "findings": []
}
```

On accepted reviewer completion the server writes the authoritative H3 `workspace.json` and prepares the execution plan. Do not hand-edit a second workspace copy.

## 4. Execution and reference assets

When bootstrap returns:

```text
pipeline.nextStage = execution
```

planning is finished.

Actual character/scene/prop reference images must then be bound to the current project. Users can do this from **02 自动执行 / 审片 → 资产索引 → 上传参考图**.

After assets are bound:

```text
POST /api/auto/plan
```

rebuilds the H3 queue and asset gate.

Real GPU generation remains confirmation-gated:

```text
POST /api/auto/start
{ "confirmGeneration": true }
```

Same Scene runs strictly in sequence. The previous Sequence's final frame is extracted and supplied to the next Sequence as a normal Ref2VA continuity reference. Crossing a Scene clears that relation frame.

## 5. Source and user edits are locked facts

Never silently rewrite:

- source dialogue;
- user-approved wording;
- stable asset IDs;
- approved Shot order/action/outcome;
- existing user annotations.

If a repair is required, change only the failing scope and preserve everything not implicated by the finding.

## 6. Development rules for this public repository

- Keep README and `.env.example` aligned with the default Agent-owned mode.
- The public app must boot without any model API key.
- Never commit `.env`, runtime `data/`, user assets, generated videos, relation frames, logs, or machine-specific configuration.
- Keep direct-provider code behind explicit legacy opt-in; do not make it the default UX.
- Before shipping code changes run:

```bash
npm run check
```

- Verify the public UI labels the edition clearly as **独立开源版 / Agent-owned** and never implies that this checkout is Nana's private production Director Console.
