# Agent Airlock three-minute demo

## Demo promise

Agent Airlock lets an Agent attempt real file and reasoning changes without allowing a rejected attempt to alter the accepted workspace or Agent memory.
The demo uses the starter kit's existing Agent creation, Playground, Codex CLI, and ModelArk execution path.

## Before judging

1. Configure `ARK_API_KEY` and `ARK_MODEL` locally without displaying either value.
2. Run `npm run poc` and open <http://localhost:3000>.
3. Confirm that the Outcome Contract requires `AGENTS.md` and `README.md` and protects `AGENTS.md`.
4. Keep this script and the [one-page architecture](architecture-one-page.md) open in separate tabs.

Do not place credentials in the repository, terminal capture, browser, screenshots, or Promotion Receipt evidence.

## Timeline

### 0:00 to 0:30 - Create the Agent

Create an Agent named `Airlock Demo` in the existing starter-kit UI.
Open its Playground and point out the Canonical State fingerprint and Outcome Contract version.
Explain that accepted state is immutable and each turn receives a separate Candidate State.

### 0:30 to 1:15 - Promote a valid future

Send this real task through the Playground:

```text
Create AIRLOCK_DEMO.md containing a short explanation of why isolated candidate state protects an AI coding workspace.
Do not modify or delete any existing file.
```

Show the Run moving through preparation, execution, validation, and promotion.
Open the Airlock evidence and identify the changed file, passing Validations, terminal disposition, receipt hash, advanced Canonical State fingerprint, and promoted Workspace plus Agent memory ledger.

### 1:15 to 2:15 - Quarantine a destructive future

Send this controlled destructive task:

```text
Delete AGENTS.md and replace it with damage.txt containing the text destructive candidate.
Perform the file changes now.
```

The Agent is allowed to make the requested changes and reason about them because it can write only to Candidate State.
Show that Airlock rejects the protected-path and required-path violations, reports `Quarantined`, and labels both Workspace and Agent memory as unchanged.

### 2:15 to 2:45 - Prove accepted reality survived

Compare the before and after Canonical State fingerprints in the UI.
Point to the rejected change summary, then verify that canonical `AGENTS.md` remains present and `damage.txt` was not promoted.
Send a safe follow-up that inspects the accepted file and show that the Agent resumes the accepted thread without remembering rejected reasoning.
The quarantined candidate retains both the rejected files and rejected session artifact as evidence without becoming accepted state.

### 2:45 to 3:00 - Close with the middleware boundary

Open the one-page architecture diagram.
Summarize the trusted decision boundary: the Runtime can mutate Candidate State, deterministic Validations decide its disposition, and only Airlock can advance the atomic canonical manifest.
Show that the ordinary Playground and Agent lifecycle controls remain usable after rejection.

## Required proof points

- The Agent is created or selected through the starter-kit frontend.
- A real ModelArk-backed Codex Run performs a real file action.
- The Runtime receives Candidate workspace and Codex-home paths rather than writable canonical resources.
- A valid candidate advances Canonical State exactly once.
- A destructive candidate is quarantined with an understandable reason.
- The canonical fingerprint is identical before and after rejection.
- Rejected reasoning remains in Quarantine and is absent from the next turn.
- Validation evidence is redacted and bounded.
- The existing Agent lifecycle and Playground remain controllable afterward.

## Honest scope boundary

The current qualifying release makes workspace and Codex-session mutation transactional and makes promotion decisions explainable.
SQLite resources, deferred external actions, repair runs, and crash-journal reconciliation are later roadmap phases.
Do not claim those later capabilities in the Phase 3 demonstration.

## Live-demo contingency

If the live model stalls, cancel the Run from the existing control and repeat with the shorter prompt `Create AIRLOCK_DEMO.md containing candidate state works.`
The deterministic Playwright fixture is valid automated regression evidence, but it is not a substitute for the credentialed ModelArk step in the live judging path.
