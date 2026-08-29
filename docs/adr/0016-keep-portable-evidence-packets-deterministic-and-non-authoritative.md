# ADR 0016: Keep Portable Evidence Packets deterministic and non-authoritative

**Status:** Accepted

**Date:** 2026-08-27

## Context

The receipt envelope, transparency proof, and offline EVM payload were independently downloadable artifacts.
That separation is useful for protocol inspection but creates avoidable friction during a short judge demo and makes it easier to pair an optional proof with the wrong receipt.
A one-file artifact is valuable only if it does not blur the difference between producer evidence and evaluator-controlled trust.

## Decision

Define `agent-airlock/portable-evidence-packet` version 1 as a strict deterministic container with exactly one Portable Promotion Envelope, one optional transparency anchor proof, and one optional offline EVM payload.
The packet carries no additional signature and makes no independent correctness, identity, authority, publication, or timestamp claim.
The verifier validates the receipt first and requires every included optional component to bind to the exact verified receipt digest.
An included invalid component rejects the packet.
An absent optional component does not weaken or invalidate the receipt.
The packet excludes signed trust policies, Policy Authority Rotations, and Authority Trust Roots.
Those artifacts remain separate evaluator inputs so the evidence producer cannot select the authority that judges its own signer.
The parser rejects unknown fields and limits the complete file to 2 MB.

## Consequences

Judges can download and independently verify one coherent artifact without manually matching digests across files.
Protocol users can still download and inspect the envelope, anchor, and EVM payload separately.
Node, CLI, and browser verifiers share the same fail-closed component-binding behavior.
The packet is useful without a blockchain, wallet, RPC endpoint, server, database, or model credential.
Future packet versions must not silently add self-authorizing trust material or reinterpret optional evidence as Promotion authority.
