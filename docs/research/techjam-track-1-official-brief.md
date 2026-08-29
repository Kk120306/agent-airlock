# TikTok TechJam 2026 Track 1 official brief and Agent Airlock gap analysis

Research completed on 29 August 2026 against the official Track 1 information page, workshop recording, CodeJam starter repository, Devpost overview, and Devpost rules.

## Executive verdict

Agent Airlock is an unusually direct fit for Track 1.

The official challenge is to "build the missing middleware, not the platform" by adding one coherent, reusable, functional, and testable Agent middleware capability while preserving the starter kit's lifecycle and Playground.
The official workshop identifies state isolation, recovery, and evidence as central infrastructure problems for long-running Agents.
Agent Airlock answers those problems with one platform-level guarantee: every Run executes against isolated Candidate State, required Outcome Contract checks decide whether that future may be promoted, rejected work cannot mutate Canonical State, and every decision retains recovery lineage and durable evidence.

The product is already stronger than the minimum technical bar.
The remaining risks are submission packaging and presentation, not the core idea.
The current GitHub repository is private and no public three-minute YouTube demo is linked.
The repository now includes a static one-page architecture PNG and ready-to-paste Devpost copy with an explicit stack inventory and the general innovation, feasibility, and impact argument.

## Source precedence

If the sources appear to disagree, use this order:

1. The [official Devpost rules](https://tiktoktechjam2026.devpost.com/rules) govern eligibility, deadlines, submission legality, and general judging.
2. The latest written [Track 1 brief](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc#Yeaqdh5BSoBioxxiLpYmGsJlyyc), last updated 28 August, governs Track 1 requirements and scoring.
3. The [official Track 1 workshop](https://bytedance.my.larkoffice.com/minutes/obmyo2nvz5ht46844444284t) clarifies intent and acceptable implementation choices.
4. The [official CodeJam starter repository](https://github.com/RrankPyramid/CodeJam) governs the inherited baseline and its operating instructions.

The workshop transcript is machine-generated and contains transcription errors.
Timestamped workshop statements are therefore useful clarification, while the newer written brief and Devpost rules should control any conflict.

## What Track 1 actually asks teams to build

The Track 1 motto is "Build the missing middleware, not the platform."
The target is one meaningful capability that works across Agents at a platform seam, not a behavior that only one specially prompted Agent can perform.
The documented extension seams are the Fastify request boundary, `AgentService`, `AgentRunner`, and the execution data model.

The official requirements are:

- Preserve Agent creation, editing, deletion, lifecycle controls, Playground chat, Run status, persistence, and model execution.
- Put the substantive behavior in the backend, Runtime, data, or infrastructure path.
- Use the existing control plane, persistent workspaces and sessions, and local Runtime boundary at the narrowest useful seam.
- Explain component ownership, the trust boundary, the data that crosses it, and what happens when the middleware fails.
- Demonstrate a normal path and a meaningful failure, denial, degraded, abuse, or recovery path.
- Preserve convincing evidence for the middleware decision.
- Add automated verification for the core behavior.
- Keep credentials and unredacted sensitive data out of source, Git history, logs, traces, screenshots, browser storage, and output.
- Prefer one deep, coherent middleware story over a broad feature list.

The written brief explicitly treats the suggested middleware directions as examples rather than a checklist.
It also explicitly allows controlled fixtures and mock third-party resources when the frontend-to-Agent flow and middleware behavior are real.
The [Track 1 scope and design requirements](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc#YwdBdkDiQo5amLxJrWSmEn47yhd) are the primary source for these constraints.

### What is deliberately not required

The organizers do not require a rebuilt Agent platform, production OAuth, a general-purpose policy engine, a microVM sandbox, a distributed scheduler, multi-region infrastructure, or a cosmetic redesign.
The official workshop also clarifies that ECS does not affect the score and local Docker-compatible execution is sufficient.
Model choice is not scored, and the workshop permits another Responses-compatible provider or a small adapter instead of ModelArk.

This means paid ModelArk inference is not a prerequisite for a compliant Track 1 demonstration.
The safest no-cost position is to retain and document the working ModelArk-compatible adapter, disclose the deterministic local Responses provider, and visibly prove a real Codex, container, file, SQLite, session, or infrastructure action.
This interpretation follows both the workshop clarification and the written demo requirement, which asks for at least one real model **or** file **or** tool **or** sandbox **or** data **or** infrastructure action.

### Workshop clarification map

The following timestamps are from the [official Track 1 workshop](https://bytedance.my.larkoffice.com/minutes/obmyo2nvz5ht46844444284t):

| Time | Clarification |
| --- | --- |
| 05:00-06:49 | Long-running Agent bottlenecks have shifted below prompts and models into infrastructure, including state isolation, recovery, and evidence. |
| 13:54-15:15 | Teams should implement one meaningful capability, preserve Create Agent and Playground, and connect the behavior to a trusted boundary. |
| 21:43-23:15 | BytePlus Ark is an example rather than a mandate, and other OpenAI-compatible providers or a small adapter are acceptable. |
| 23:15-23:51 | Checkpoint, resume, recovery, and persistent evidence qualify when they are reusable platform capabilities for Agents rather than one custom Agent feature. |
| 25:01 | Model choice is not a judging criterion. |
| 25:41-26:43 | An Ark-connected Codex Runtime and remote ECS are not required, and a local container POC is acceptable. |
| 26:43 | A Responses-compatible provider or a Chat Completions-to-Responses adapter is acceptable. |
| 34:38-35:32 | The speaker verbally describes the video as the only required deliverable, but this conflicts with the later written brief and Devpost requirements. |
| 36:59-38:24 | The capability should be a clear, reproducible product feature, and trust should be supported by demonstrated evidence. |

## Starter kit expectations

The [official starter kit](https://github.com/RrankPyramid/CodeJam) already supplies the platform that Track 1 teams must extend:

- A React browser interface with Agent CRUD, lifecycle controls, Playground chat, and Run status.
- A Fastify control plane with validation, asynchronous Runs, `AgentService`, and persistence.
- `AgentRunner` implementations, a persistent workspace per Agent, and persistent Codex sessions.
- Codex CLI execution in disposable local containers.
- A Responses-compatible model path demonstrated with BytePlus ModelArk.
- Docker, Colima, or Podman as the recommended local judging route, with ECS as an optional deployment path.

The written baseline calls for macOS or Linux, Node.js 22 or newer, npm 10 or newer, and a supported container engine.
The starter documentation includes the following acceptance flow:

1. Start the application and create an Agent from the browser.
2. Give it the task `Create a TypeScript hello-world CLI, add a test, run it, and summarize what you changed.`
3. Receive the assistant response.
4. Send a follow-up that continues the same Codex session.
5. Stop and restart the application and confirm that the workspace persists.
6. Run `npm run check` successfully.

Relevant official starter documents are the [README](https://github.com/RrankPyramid/CodeJam/blob/main/README.md), [local POC guide](https://github.com/RrankPyramid/CodeJam/blob/main/docs/LOCAL_POC.md), [architecture](https://github.com/RrankPyramid/CodeJam/blob/main/docs/ARCHITECTURE.md), and [deployment guide](https://github.com/RrankPyramid/CodeJam/blob/main/docs/DEPLOYMENT.md).

## Required three-minute demonstration

The latest written [Track 1 demo instructions](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc#UPyPdy5stog82lxIjXamUyxRyVb) require this six-part story:

1. Create or select an Agent in the frontend and show its lifecycle state.
2. Invoke the Agent through the Playground with a real task.
3. Show at least one real model, file, tool, sandbox, data, or infrastructure action.
4. Show the middleware behavior and its evidence.
5. Show an appropriate failure, denial, degraded, abuse, or recovery case.
6. Show that the platform remains understandable and controllable afterward.

A controlled model fixture or mocked external resource is allowed, but the frontend-to-Agent path and middleware itself must be functional.

### Strongest Agent Airlock recording sequence

1. Show the selected runnable Agent and its lifecycle state in the starter-kit Playground.
2. Invoke one real task that runs the pinned Codex CLI inside a disposable container against Candidate State.
3. Show the first Run pass every required Validation and atomically promote workspace, session, SQLite, and outbox state.
4. Show an invalid second Run fail Validation, enter Quarantine, dispatch no effect, and leave the Canonical fingerprint unchanged.
5. Show the repaired child resume retained work, pass the original Outcome Contract, and promote with bounded lineage.
6. Finish on the locally verified signed decision chain and the still-operational Playground.

This is substantially better than a generic policy-denial demo because it proves the organizer's complete isolation, failure, recovery, and evidence story in one coherent sequence.

## Required submission package

The strict combined requirement from the [Track 1 deliverables](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc#DfbAdnt0bo5NAjxrISJmkmhLy4e), [Devpost overview](https://tiktoktechjam2026.devpost.com/), and [Devpost rules](https://tiktoktechjam2026.devpost.com/rules) is:

- A public three-minute YouTube video showing the working product end to end.
- A Devpost description explaining the solution and listing the development tools, APIs, assets, and libraries used.
- A public source repository with well-structured code and a comprehensive README.
- Setup instructions, problem and rationale, design summary, automated tests, demo steps, known limitations, and no secrets.
- A one-page architecture diagram showing the middleware, data flow, trust boundary, and enforcement, instrumentation, or recovery point.
- A free, unrestricted working project or test build that remains available to judges until judging ends.
- English-language submission materials.

The workshop casually describes the video as the only deliverable at one point.
That statement conflicts with the newer written Track 1 page and Devpost submission rules, so the repository, description, architecture diagram, and access requirements must still be completed.

### Official acceptance gate

The written [Track 1 acceptance criteria](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc#TOr0dlWjsoqXSCxe4Jim6CHnyLg) require a reviewer to be able to clone and start the project, create or select an Agent, exercise the feature from the frontend, observe meaningful middleware in a real backend, Runtime, data, or infrastructure path, reproduce the documented behavior, and run `npm run check`.
No secret may appear in source, history, logs, traces, screenshots, browser storage, or output.
Permission evidence, correlated traces, a blocked threat, and lifecycle or reliability evidence are useful optional proofs rather than mandatory separate features.
The [Track 1 FAQ](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc#JTkmdejc4ot6tNxYhvhmzM34yLe) reinforces that local containers are the default, ECS is optional, example directions are optional, controlled fixtures are acceptable, and UI polish by itself is not middleware.

## Scoring model

The [Track 1 rubric](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc#NvBudiXocod0xSxblYQmB8RKyDb) is:

| Category | Weight | What the judges need to see |
| --- | ---: | --- |
| End-to-end middleware behavior | 40% | One real browser-to-Agent-to-middleware path, including evidence and a meaningful failure or recovery path. |
| Technical design and integration | 25% | A narrow, justified starter-kit seam, a clear trust boundary, correct ownership, and coherent failure semantics. |
| Verification and robustness | 20% | Automated tests, adversarial cases, restart behavior, safe failure, redaction, and reproducible evidence. |
| Demo and reproducibility | 15% | A clear three-minute story, public code, simple setup, stable commands, and honest limitations. |

Devpost Stage 1 is a pass or fail screen for theme fit and reasonable use of the featured required APIs or SDKs.
Agent Airlock should make its CodeJam starter-kit inheritance, preserved model integration, and `AgentRunner` extension seam unmistakable in the README and description.

The Devpost rules also apply four equally weighted Stage 2 categories:

| General category | Agent Airlock angle |
| --- | --- |
| Technical Execution | Real transactional state boundaries, Promotion recovery, constrained Validation, durable evidence, and end-to-end browser proof. |
| Innovation and Problem Insight | Agents can create many possible futures, but existing middleware lacks a transaction boundary for deciding which future becomes accepted reality. |
| Feasibility and Practicality | The design extends the supplied `AgentRunner` seam, runs locally, requires no paid service for judging, and preserves the existing operator workflow. |
| Impact and Relevance | Safe failure and recoverable work are prerequisites for trusting Agents with repositories, memory, data, and external actions. |

The Track 1 rubric should control the demo structure, while the general Devpost categories should control the written story and final pitch.
Presentation and Communication also applies at the final event.

## Current Agent Airlock alignment

| Requirement | Status | Repository evidence | Assessment |
| --- | --- | --- | --- |
| One reusable middleware capability | Pass | [README](../../README.md) and [domain context](../../CONTEXT.md) | Transactional Agent execution is one cross-Agent platform guarantee rather than one custom Agent behavior. |
| Preserve starter-kit lifecycle and Playground | Pass | [web application](../../apps/web/src/App.tsx), [AgentService tests](../../apps/server/src/agent-service.test.ts), and [baseline E2E](../../tests/e2e/baseline.spec.ts) | Agent CRUD, start and stop, Playground conversation, persistent state, and the Runner seam remain present and tested. |
| Real backend, Runtime, data, or infrastructure behavior | Pass | [real-container browser proof](../../tests/container-browser/real-container.spec.ts) and [architecture](../demo/architecture-one-page.md) | The canonical proof uses production React and Fastify, the pinned Codex CLI, a disposable container, files, SQLite, session state, and a deferred outbox. |
| Normal path plus meaningful failure or recovery | Pass | [three-minute script](../demo/three-minute-demo.md) | Promotion, invalid Candidate Quarantine, and promoted Repair form a single visible sequence. |
| Middleware evidence | Pass | [submission brief](../demo/SUBMISSION_BRIEF.md) | Fingerprints, resource dispositions, Validation results, effects, receipts, and signed Repair lineage are derived from persisted Runs. |
| Automated verification | Pass | [`npm run check`](../../package.json) and the focused browser, server, Runtime, recovery, and protocol tests | The core behavior is much more thoroughly verified than the minimum requirement. |
| Honest no-cost local judge path | Pass | [README canonical proof](../../README.md) | `npm run prove:runtime -- --reset --headed` uses a disclosed deterministic local Responses fixture while preserving real Codex, Runtime, file, data, and middleware actions. |
| Show a selected Agent and lifecycle state | Pass | [recording UI](../../apps/web/src/App.tsx) and [recording script](../demo/three-minute-demo.md) | Recording mode names the selected Agent, exposes its status, and ends with an enabled `Continue in Playground` control while the Agent remains READY. |
| One-page architecture deliverable | Pass | [architecture page](../demo/architecture-one-page.md) and [static PNG](../demo/agent-airlock-one-page.png) | The upload-ready static diagram shows the shared seam, protected resources, trust boundary, decision branches, recovery point, effects, and evidence role. |
| Comprehensive public repository | Fail | Local `gh repo view` check on 29 August 2026 | `Kk120306/agent-airlock` is currently private even though Devpost requires a public repository. |
| Public three-minute YouTube demo | Fail | Repository-wide link search on 29 August 2026 | No YouTube or `youtu.be` link is present. |
| Devpost-ready description and stack inventory | Pass | [Devpost submission copy](../demo/DEVPOST_SUBMISSION.md) | The ready-to-paste package explicitly lists tools, APIs, assets, and libraries and covers innovation, feasibility, impact, setup, limitations, and evidence. |
| Free judge access until judging ends | Partial | [README canonical proof](../../README.md) | The no-key local proof is appropriate, but judges cannot use it until the repository is public and clean-clone instructions are confirmed from the public URL. |
| No secret exposure | Pass with final audit required | [judge checklist](../demo/JUDGE_CHECKLIST.md) | The design and release checks emphasize credential-safe output, but repository history, video frames, browser storage, and uploaded artifacts still need a final submission audit. |
| New or significantly updated during the submission period | Pass based on local Git evidence | Commits `0afd36c`, `a6e0ae7`, and `511401a` | The repository was created before the window, but 38 files changed with 2,911 insertions and 444 deletions after 29 August at 12:00 SGT, which is strong evidence of a significant update. |

## Precise remaining gaps

### P0 submission blockers

1. Make `Kk120306/agent-airlock` public only after a secret and Git-history audit.
   Devpost explicitly requires a public code repository.
2. Record, upload, and link one public three-minute YouTube demonstration.
   The existing rehearsal and proof automation are not substitutes for the submitted video URL.
3. Upload the prepared static one-page architecture PNG with the Devpost submission.
   The repository asset already covers the required components, flow, trust boundary, and recovery point.
4. Paste the prepared Devpost description, replace its repository and video placeholders, and check the rendered submission.
   The repository copy already includes the explicit stack inventory and the four general judging arguments.
5. Confirm both official registration and Devpost registration, team eligibility, and English-language submission fields.
   These owner actions cannot be proven from the repository.

### P1 demo risks

1. Make the opening five seconds unmistakably satisfy "create or select an Agent" and "show lifecycle state."
   The current recording screen shows both, but the voice-over must call them out because the seeded selection is automatic.
2. State the provider boundary in one sentence.
   Say that the local Responses fixture replaces only paid inference while the actual browser, Fastify control plane, Codex CLI, container, Candidate filesystem, SQLite state, outbox, Validation, and Promotion path are real.
3. Keep the story on one capability.
   Present signed evidence, repair lineage, deferred effects, and offline verification as proof of the same transactional execution guarantee, not as separate products.
4. Make the invalid Candidate failure legible at a glance.
   The judge should see failed Validation, zero dispatched effects, four quarantined resources, and identical before and after Canonical fingerprints without scrolling.
5. End on controllability.
   The final frame should show verified lineage and a healthy selected Agent or Playground, proving the failure did not make the platform opaque or unusable.

### P2 narrative improvements

1. Lead with the missing transaction boundary rather than blockchain, authentication, multi-Agent communication, or a general list of safety features.
2. Explain the user consequence in plain language: an Agent may try many changes, but rejected code, memory, data, and external actions never become accepted reality.
3. Explain why ordinary Git branches are insufficient: the protected state also includes Agent memory, structured data, and deferred external effects, and Promotion must decide them together.
4. Explain why this is feasible: it extends the provided `AgentRunner` and persistence seams and works on the recommended local container route.
5. State deliberate non-claims clearly, including ordinary containers not being a hardened multi-tenant sandbox and arbitrary network egress being outside the typed outbox guarantee.

## Recommended submission positioning

Use this one-sentence pitch:

> Agent Airlock is transactional execution middleware for AI Agents: every Run explores an isolated future, and only a future that passes its Outcome Contract can atomically become accepted reality.

Use this product proof:

> The same starter-kit Agent promotes a valid four-resource change, quarantines an invalid future without changing Canonical State or firing its effect, and repairs the retained work through a signed, locally verifiable lineage.

Use this concise explanation of the provider choice:

> The demo uses a deterministic local Responses provider so judges never depend on paid capacity; the real starter-kit browser, control plane, Codex CLI, container Runtime, files, session, SQLite data, outbox, Validation, Promotion, and recovery path all execute live.

Do not lead with optional blockchain publication.
The Track 1 value is the trusted transaction boundary and recovery evidence.
Portable signatures and optional digest anchoring are supporting evidence, not Promotion authority and not the product's central claim.

## Submission-day checklist

- [ ] Confirm the entrant and every teammate meet the official eligibility rules.
- [ ] Confirm registration in both the official form and Devpost.
- [ ] Run the secret and Git-history audit.
- [ ] Make the GitHub repository public.
- [ ] Test a clean clone from the public URL with no ModelArk key.
- [ ] Run `npm run check` and the canonical headed Runtime proof.
- [ ] Export and inspect the one-page architecture at presentation resolution.
- [ ] Record one uninterrupted three-minute demo with normal, failure, recovery, evidence, and final controllability.
- [ ] Inspect every video frame and artifact for credentials, local paths, private URLs, and unredacted content.
- [ ] Upload the video publicly to YouTube and add the link to the README and Devpost.
- [ ] Paste the final English description and explicit stack, API, asset, and library inventory into Devpost.
- [ ] Keep the public repository and free test path available through the judging period.
- [ ] Submit before 1 September 2026 at 12:00 SGT.

## Eligibility and event timeline

The [official rules](https://tiktoktechjam2026.devpost.com/rules) require entrants to be at least 18, currently reside in Singapore, be enrolled at a Singapore university, and expect to graduate in December 2026 or later.
Valid government identification is required, teams may contain up to five people, and current TikTok interns, employees, judges, promotion partners, and conflicted persons are ineligible.

The [official timeline](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc#doxmyNd1vC9IwfYkk4OkzuwTfme) uses Singapore time:

- Submission window: 29 August 2026 at 12:00 to 1 September 2026 at 12:00.
- Judging and public voting: 1 September at 15:00 to 7 September at 15:00.
- Finalists announced: 8 September.
- Grand Final: 11 September from 09:00 to 18:00.
- Winners announced: around 15 September.

The project existed before the submission window, so preserve the post-noon 29 August commit history as evidence of significant work during the eligible period.

## Official sources

- [TikTok TechJam 2026 information document](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc).
- [Track 1: Agent Launchpad](https://bytedance.larkoffice.com/wiki/GdYFwzWNLiREsSkuIjZcDznInWc#Yeaqdh5BSoBioxxiLpYmGsJlyyc).
- [Track 1 workshop recording and transcript](https://bytedance.my.larkoffice.com/minutes/obmyo2nvz5ht46844444284t).
- [Official CodeJam starter kit](https://github.com/RrankPyramid/CodeJam), reviewed at main commit `8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`.
- [TikTok TechJam 2026 Devpost overview](https://tiktoktechjam2026.devpost.com/).
- [TikTok TechJam 2026 official rules](https://tiktoktechjam2026.devpost.com/rules).

## Concise implications for Agent Airlock

No concept pivot is needed.
No blockchain dependency is needed.
No paid ModelArk capacity is needed for the core proof.
The winning move is to stop broadening the product, package the current transactional execution story with absolute clarity, and remove the two remaining owner-controlled submission risks: the private repository and missing public video.
