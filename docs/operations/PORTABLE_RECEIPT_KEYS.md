# Portable receipt key rotation and compromise runbook

## Scope

This runbook covers the Ed25519 key that signs Portable Promotion Receipts and the separate Ed25519 key that signs local transparency checkpoints.
It does not cover ModelArk credentials, application authentication tokens, provider credentials, wallets, or public-chain accounts.

Portable receipt verification is mathematical and self-contained.
An envelope includes the exact public JWK and verified key fingerprint used for its signature.
Organizational trust in that key is a separate operator policy decision.

## Default custody

The server creates each private key only when the corresponding optional feature is first used.
The default receipt key is under `APP_DATA_DIR/keys/portable-receipt-ed25519.pem`.
The default transparency key is under `APP_DATA_DIR/keys/portable-transparency-ed25519.pem`.
The default transparency log is under `APP_DATA_DIR/transparency/portable-transparency-log.json`.
Each key has an adjacent non-secret identity marker named `<key-path>.key-id.json`.
The marker records only the public key fingerprint and lets Airlock detect loss or substitution instead of silently creating a different signing identity.
The database, receipt envelope, browser response, transparency log, EVM payload, fixture set, and Git repository never contain a private key.

On supported Unix systems, the key directory is owner-only and the key file and identity marker are mode `0600`.
Startup export refuses a symbolic link, non-regular file, oversized file, non-Ed25519 key, group-readable or world-readable permissions, malformed marker, missing key with an existing marker, or key whose fingerprint contradicts its marker.
Back up private keys only into an operator-controlled encrypted secret store.
Never copy a private key into `.env`, issue text, chat, logs, a receipt, or an anchor.

## Planned rotation

1. Finish or stop active receipt exports.
2. Generate a new key and identity marker at a new operator-controlled path with `agent-airlock-receipt keygen <new-path>`.
3. Record the printed public key fingerprint in the operator's trust inventory.
4. Set `AIRLOCK_PORTABLE_SIGNING_KEY_PATH` to the new path and restart the server.
5. Export one new receipt and verify that its `keyId` is the recorded new fingerprint.
6. Verify one historical envelope offline and confirm that its original signature still passes under its included original public JWK.
7. Mark the old key retired in the external trust inventory with an effective time.
8. Keep the old public key fingerprint and historical envelopes.
9. Retain or destroy the old private key according to the organization's retention policy after confirming that no new receipt uses it.

Rotate the transparency key independently with `AIRLOCK_TRANSPARENCY_SIGNING_KEY_PATH` and start a new log at a new `AIRLOCK_TRANSPARENCY_LOG_PATH`.
One local transparency log is bound to one checkpoint identity, so a key rotation cannot silently continue the old history.
Retain the final old checkpoint and old log externally, then record the new log and key fingerprint as a separate trust epoch.

## Transparency log process safety

Every log append re-reads and validates the complete persisted chain while holding an interprocess lock at `<log-path>.lock`.
The writer commits through a same-directory temporary file, synchronizes the file, replaces the log atomically, and synchronizes the parent directory before releasing its owned lock.
A lock records a process identifier and unique ownership nonce.
Airlock removes an old lock automatically only when the lock is older than the stale boundary and the recorded process no longer exists.
A live process retains ownership even when an append takes longer than the stale boundary, and a writer never removes a replacement lock that carries a different nonce.
An invalid, symbolic-link, oversized, or live contended lock fails closed.
If a crashed host leaves an unrecoverable invalid lock, preserve the log and lock for diagnosis, verify that no writer is active, and move the lock aside manually before retrying.

## Suspected compromise

1. Stop receipt export and optional transparency anchoring.
2. Preserve the affected key file, relevant envelopes, local transparency log, server revision, and filesystem metadata for investigation.
3. Compute or retrieve the compromised key fingerprint without publishing the private key.
4. Mark that fingerprint compromised in the organization's external trust policy with the earliest defensible effective time.
5. Generate replacement receipt and transparency keys at new paths.
6. Restart with the replacement paths and verify their new fingerprints.
7. Reissue current receipts only when business policy requires a new statement from the replacement key.
8. Do not rewrite, delete, or relabel historical signatures as mathematically invalid.

A historical signature made by a compromised key can remain mathematically valid.
The correct trust report is that signature verification passed but organizational trust failed or became uncertain for the relevant time window.
An optional blockchain or transparency anchor cannot prove that a compromised signer was trustworthy when it signed.
The browser verifier implements this separation through a bounded external `agent-airlock/signing-key-trust-policy` document.
Sign that policy with a separate policy-authority key, distribute its fingerprint independently from receipt producers, keep key rules sorted by fingerprint, and use exact Agent and disposition scopes whenever authority is not global.
Never accept the authority public key inside a signed policy as its own trust root.
Pin the expected `sha256:` authority fingerprint through evaluator-controlled configuration or direct verified exchange before importing the policy.

## Policy Authority rotation

Generate the next Policy Authority key separately and keep both private keys outside Agent Runtime mounts.
Create a bounded `agent-airlock/policy-authority-rotation` statement that names the pinned previous key, exact next public key and fingerprint, issuance time, effective time, and optional expiry.
Sign the rotation with the previous authority by using `agent-airlock-receipt sign-authority-rotation`.
Verify it independently with `agent-airlock-receipt verify-authority-rotation --authority <pinned-root>` before distributing a policy signed by the next key.
Consumers may verify that policy with `agent-airlock-receipt verify-policy --authority <pinned-root> --rotation <signed-rotation.json>`.
Treat a missing, tampered, early, expired, or unpinned transition as unauthorized.
If the previous authority may be compromised, do not rely on its rotation signature and replace the pinned root through an independent incident-response channel.
Mark a compromised key as compromised rather than shortening its window because a signer-claimed receipt timestamp cannot prove that a forged receipt predates compromise.

## Lost key

A lost private key prevents new signatures with that identity but does not prevent verification of existing envelopes.
Generate a replacement key, record its new fingerprint, and mark the old key retired or lost in the external trust inventory.
Do not delete the old identity marker to make Airlock regenerate a key at the same path.
Use a new path so the custody event and new fingerprint remain explicit.
Do not copy the public JWK from an old envelope into a new envelope unless the matching private key actually signs the new receipt.

## Verification checklist

- `npm run check:phase11:protocol` passes offline.
- A receipt signed by the new key reports the expected new fingerprint.
- A historical receipt still verifies under its included original public JWK.
- A one-bit content or signature change fails verification.
- The private key is a non-symbolic-link regular file with owner-only access.
- The adjacent identity marker is a canonical non-symbolic-link regular file with owner-only access and the expected public key fingerprint.
- Removing or substituting a key while its identity marker remains causes export to fail closed.
- No private key appears in Git, the JSON store, browser output, logs, receipts, anchors, or test vectors.
- Receipt verification still succeeds when local anchoring is disabled.
- EVM payload generation reports zero network calls and zero funds spent.
