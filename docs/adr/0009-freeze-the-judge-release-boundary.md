# ADR 0009: Freeze the judge release boundary around one deterministic hero path

## Status

Accepted for the Phase 7 release.

## Context

Agent Airlock has working behavior across Promotion, Quarantine, Whole-Agent continuity, SQLite, deferred actions, Repair lineage, interruption recovery, and bounded retention.
Adding more capabilities before judging would increase cognitive load and risk destabilizing the falsifiable guarantee that already satisfies the track.

Organizer-provided ModelArk credentials are not yet available.
Development and judging rehearsal must not require paid inference, but the release must still exercise the production frontend, control plane, Runtime seam, state manager, validator, journal, persistence, SQLite, and effect dispatcher.

## Decision

The Phase 7 release freezes P0 product scope at Phases 0 through 7.
The judge path contains exactly four operator actions:

1. Promote a multi-resource future.
2. Quarantine a destructive future and prove Canonical State is unchanged.
3. Repair the retained Quarantine through bounded lineage and promote the repaired future.
4. Continue the accepted Agent session after repair.

`npm run demo -- --reset` is the canonical rehearsal command.
It builds the production application, binds only to loopback, seeds one Agent, uses an isolated persistent data root, and invokes the deterministic local Codex protocol fixture.
The launcher configures an unreachable loopback Ark URL and labels fixture mode in the terminal, `/api/system`, sidebar, and main UI.
Server startup rejects demo mode unless the loopback host, loopback Ark URL, local-process Runtime, fixture binary, fixture key marker, and fixture model marker all match the no-cost profile.
The launcher checks port availability before reset, marks demo-owned roots, and refuses to clear a nonempty unmarked directory.

The credentialed `npm run poc` starter-kit path remains unchanged and is the separate live ModelArk conformance path after organizer credentials arrive.
The release does not treat fixture output as proof of model quality.
It treats the fixture as reproducible proof of the middleware behavior around the model boundary, which the track explicitly permits through controlled fixtures and mock resources.

Phases 8 through 11 remain documented post-hackathon directions and cannot enter the release branch before submission.

## Acceptance bar

- One production Chrome journey asserts the complete four-step story in under 180 seconds.
- A 390-pixel viewport has no document-level horizontal overflow or unreachable judge controls.
- Launcher integration proves reset, restart persistence, signal handling, seeding, and port-conflict behavior.
- `npm run check:phase7` includes every prior phase gate, the deterministic launcher and browser journeys, and the release audit.
- A clean temporary clone can install, start, and pass the Phase 7 gate without undocumented state.
- The README, demo narration, architecture, security policy, PRD, roadmap, recovery guide, UI, and persisted evidence use the same state names and limitations.
- No credential or paid inference request is used for release verification.

## Consequences

The submission has one memorable product story instead of several loosely connected capabilities.
Reviewers can reproduce all middleware evidence without organizer credentials or spending money.
The distinction between deterministic middleware proof and live ModelArk conformance is visible and auditable.

Potential post-hackathon breadth is postponed, including a Transactional Resource SDK, competing futures, adaptive contract suggestions, portable signed receipts, blockchain anchoring, and multi-Agent coordination.
This is deliberate scope control rather than an architectural prohibition.
