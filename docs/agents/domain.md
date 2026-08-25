# Domain Docs

This repository uses one domain context.

## Before exploring

- Read `CONTEXT.md` at the repository root.
- Read ADRs under `docs/adr/` that affect the area being changed.
- Proceed silently when an unrelated optional domain document does not exist.

## File structure

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── apps/
```

## Vocabulary

Use the terms defined in `CONTEXT.md` in issue titles, type names, test names, documentation, and architectural discussion.
Do not substitute synonyms that the glossary explicitly marks as avoided.

When the required concept is missing, use domain modeling to define it before spreading new language across the repository.

## Architectural decisions

Surface conflicts with existing ADRs explicitly.
Do not silently override or contradict an accepted decision.

