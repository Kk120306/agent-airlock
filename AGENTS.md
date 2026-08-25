# Agent Airlock repository instructions

## Mission

Agent Airlock extends the CodeJam starter kit with transactional execution middleware.
Every Agent Run executes against isolated Candidate State, and only a validated Candidate State may replace Canonical State.

## Required context

Read these files before planning or changing Agent Airlock behavior:

- `CONTEXT.md` for canonical domain language.
- `docs/product/PRD.md` for product requirements and scope.
- `docs/architecture/agent-airlock.md` for the intended execution seam and trust model.
- Relevant records under `docs/adr/` before revisiting an architectural decision.
- `docs/agents/issue-tracker.md` before creating or editing project issues.
- `.omx/plans/agent-airlock.md` for the current implementation sequence.

## Starter kit constraints

- Preserve Agent CRUD, lifecycle controls, Playground chat, persistent workspaces, persistent Codex sessions, and model execution.
- Treat `RrankPyramid/CodeJam` as the upstream starter repository.
- Add middleware at the narrowest useful seam around `AgentRunner`, workspace resolution, and Run persistence.
- Keep local Docker, Colima, or Podman execution as the primary development and judging path.
- Do not make ECS deployment necessary for the demo.

## Airlock invariants

- Never execute an Agent Run against Canonical State.
- Never expose a mutable Canonical State path inside an Agent Runtime.
- Never promote a Candidate State unless every required Outcome Contract check has passed.
- A rejected, failed, cancelled, or timed-out Run must leave Canonical State unchanged.
- Promotion must be recoverable after process interruption.
- External Action Intents must be deferred until promotion and carry stable idempotency keys.
- Never persist or display API keys, credentials, environment-variable values, or unredacted sensitive content.
- Preserve evidence for every validation and lifecycle decision.

## Engineering workflow

- Reproduce behavior through the browser-to-Runtime path before fixing a bug.
- Prefer tests at the `AgentRunner` seam and HTTP boundary over tests of implementation details.
- Add focused unit tests only for complex pure policy evaluation.
- Run `npm run check` before handing off a change.
- Keep the baseline acceptance flow working after every vertical slice.
- Use `rg` and `rg --files` for repository discovery.
- Use the domain terms from `CONTEXT.md` in types, tests, issues, and documentation.
- Record only decisions that are hard to reverse, surprising, and based on real trade-offs as ADRs.

## Agent skills

### Issue tracker

Project decisions and implementation work are tracked in GitHub Issues for `Kk120306/agent-airlock`.
See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single domain context with `CONTEXT.md` at the root and architectural decisions under `docs/adr/`.
See `docs/agents/domain.md`.

### Wayfinder

Large unresolved efforts begin as a GitHub issue labelled `wayfinder:map` with decision tickets attached as sub-issues.
Resolve decision tickets before turning them into implementation tickets.

## Documentation conventions

- Put each complete Markdown sentence on its own physical line.
- Do not manually edit generated changelogs or generated files.
- Use Mermaid for architecture diagrams when relationships or state transitions benefit from a visual.
- Keep the PRD product-facing and keep implementation details in the architecture and plan documents.

