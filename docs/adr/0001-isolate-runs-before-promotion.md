---
status: accepted
---

# Isolate every Run before promotion

Every Agent Run will mutate isolated Candidate State rather than Canonical State, and validated Candidate State will become canonical through a recoverable Promotion.
This rejects command denylisting and mutate-then-rollback as the primary safety model because Agent behavior is difficult to predict and irreversible effects may occur before rollback begins.
The decision increases state-management complexity, but it makes the central safety claim testable: any Run that is not promoted leaves Canonical State unchanged.

