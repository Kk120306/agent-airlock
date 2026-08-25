# Issue tracker: GitHub

Issues, specifications, Wayfinder maps, and implementation tickets for this repository live in GitHub Issues at `Kk120306/agent-airlock`.
Use the `gh` CLI for project issue operations.

## Conventions

- Create an issue with `gh issue create --title "..." --body "..."`.
- Read an issue and its comments with `gh issue view <number> --comments`.
- List issues with `gh issue list --state open --json number,title,body,labels,assignees` and the appropriate filters.
- Comment with `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close an issue with `gh issue close <number> --comment "..."`.

Infer the repository from the `origin` remote when operating inside this clone.

## Pull requests as a triage surface

PRs as a request surface: no.

## Publishing behavior

When a skill says to publish to the issue tracker, create a GitHub issue in `Kk120306/agent-airlock`.
When a skill says to fetch a ticket, load the complete issue body, labels, assignees, and comments.

## Wayfinding operations

The Wayfinder map is one issue labelled `wayfinder:map`.
Decision tickets are GitHub sub-issues of that map and use one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.

- Create all decision tickets before wiring sub-issue and dependency relationships.
- Add a ticket to the map with the GitHub sub-issues endpoint.
- Use GitHub native issue dependencies for blocking relationships when the endpoint is available.
- Fall back to a `Blocked by:` line in the ticket body only when native dependencies are unavailable.
- Claim a frontier ticket by assigning it to the driving developer before doing work.
- Resolve one non-research decision ticket per Wayfinder session.
- Record the resolution as a comment, close the ticket, and append a one-line context pointer to the map.
- Refer to issues by their linked titles in user-facing text rather than by bare numbers.

The frontier consists of open, unblocked, unassigned child issues.
