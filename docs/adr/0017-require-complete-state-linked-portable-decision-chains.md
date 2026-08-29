# ADR 0017: Require complete state-linked Portable Decision Chains

**Status:** Accepted

**Date:** 2026-08-27

## Context

A repaired Run receipt commits to its parent Run and prior receipt digest.
Verifying that child alone proves the commitment but does not prove that the named parent receipt exists, is valid, or hands off the exact Canonical State from which the child began.
Importing parent and child files separately is error-prone during evaluation and cross-organization exchange.

## Decision

Define `agent-airlock/portable-decision-chain` version 1 as a strict root-to-leaf sequence of Portable Evidence Packets.
Every packet must pass its own independent verification.
The first receipt must be a depth-zero lineage root whose Run identifier equals its root identifier and whose parent and prior receipt digest are null.
Every later receipt must name the same Agent and root, the immediately preceding Run, the exact preceding receipt digest, the next depth, and the same configured maximum depth.
Every child before-state identifier and composite hash must equal the immediately preceding receipt's after-state commitment.
The leaf depth plus one must equal the packet count so a prefix cannot be presented as a complete lineage.
The parser rejects unknown fields, empty or oversized packet sequences, and files larger than 4 MB.
The chain has no signature or authority of its own and excludes trust policy and Authority Trust Roots.

## Consequences

One portable file proves the quarantined parent, repaired child, exact signed ancestry, and Canonical State continuity without the source server or database.
Reordered, truncated, unrelated, or individually valid but discontinuous receipts fail closed.
The CLI and browser can verify the same chain without a network call, upload, wallet, blockchain, or model credential.
Organizational trust remains a separate evaluator-controlled decision over each included signing key.
