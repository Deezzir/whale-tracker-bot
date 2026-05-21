# AGENTS.md

This file applies to the whole repository unless a deeper AGENTS.md overrides it.

## Operating Standard

- Answer in the user's language.
- Read relevant chat history before acting.
- Be autonomous by default: inspect, decide, implement, validate, and report.
- Ask only when ambiguity blocks a safe decision, a product choice is genuinely open, or the action is risky/destructive.
- Do not hallucinate. Verify uncertain claims through code, scripts, docs, tests, runtime output, or repository evidence.
- Preserve unrelated user changes.
- Prefer evidence over ceremony.
- Leave the system clearer, more correct, and easier to trust.

## Repository Grounding

- Start from the repository itself, not assumptions.
- For non-trivial work, read README.md and relevant docs/ early.
- Trust current code, scripts, schemas, tests, and runtime output over stale docs.
- Discover structure dynamically with tree or rg --files when needed.
- Use the repository's existing package manager, scripts, test runner, formatter, linter, build tools, and generators.
- In Codex shell sessions, prefer PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH" for node, npm, and bun.
- Do not add production dependencies without explicit approval.

## Task Mode

Classify tasks before editing:

- Direct: obvious local/cosmetic edits.
- Investigation: diagnosis when root cause is unclear.
- TDD-first: behavior, logic, contracts, auth, permissions, persistence, validation, routing, state transitions, concurrency, or non-trivial user-facing changes.

Use proportional process:

- Direct: inspect nearby usage, make the smallest coherent change, run cheap validation.
- Investigation: reproduce or trace, research vertically and horizontally, identify owning layer before patching.
- TDD-first: start with the highest-value failing test supported by the repo when practical.

## Acceptance Contract

For non-trivial work, define done, 3-5 observable criteria, primary user-visible signal, and secondary checks.

## Vertical And Horizontal Research

- Trace execution paths from UI/caller through owning layers to persistence or external systems.
- Check adjacent surfaces: sibling routes/components, hooks, services, schemas, serializers, tests, docs, loading/empty/error/success states, producer/consumer contracts.
- Do enough research to find the owner layer without wandering.

## Root Cause Discipline

- Do not patch symptoms before understanding the failure path.
- Fix the owner layer, not the nearest visible symptom.
- Reject defensive local compensation that hides upstream mistakes.
- If the smallest diff and correct diff diverge, choose the correct diff with the smallest system-wide footprint.

## Change-Surface Triggers

When touching boundaries, inspect directly coupled code:

- shared contracts/schemas;
- routes, guards, redirects, layouts;
- queries, mutations, cache keys, invalidation, optimistic/stale states;
- persistence/schema/serializers/migrations;
- auth and permissions;
- async workflows;
- user-facing legal, billing, privacy, security, or support copy.

## Minimal Sufficient Change

- Make the smallest coherent change that solves the real problem.
- Prefer flat, simple implementations and existing patterns.
- Add abstractions only when they remove real current complexity.
- Keep diffs focused and avoid unrelated formatting churn.

## Documentation Discipline

- Code is the source of truth for implementation details.
- Update README.md or docs/ only for durable architecture, setup, operations, contracts, user flows, or important engineering decisions.
- Do not create doc churn for trivial refactors.

## Testing And Validation

- Run the smallest meaningful validation covering the changed surface.
- Prefer targeted tests, typecheck, lint, build, focused scripts, then wider suites when needed.
- Treat non-zero exits, runtime errors, failed assertions, type errors, lint/build failures, and timeouts as failed validation.
- Do not declare success on proxy metrics alone if the primary user-visible signal is still broken.
- Report validation failures honestly.

## Prisma Migration Policy

- Do not hand-write Prisma migration SQL unless explicitly asked.
- Express schema changes declaratively in schema.prisma and use the repository's Prisma workflow.

## UI And Design

- Follow existing design system, component primitives, and styling conventions.
- Preserve visual language unless explicitly asked for redesign.
- Prefer parent padding plus container gap over ad hoc margins.
- Keep spacing on the shared scale.
- Treat shared visual components as closed units.
- For frontend bugs, inspect full flow: route, guard, layout, page, container, query, hook, handler, service, component, client contract, API, and persistence.

## Safety And Workspace Hygiene

- Never stop or kill processes just to free ports.
- Do not add CI/CD, hosted automation, deployment pipelines, or release ceremony unless explicitly asked.
- Do not print or commit secrets.
- Keep temporary artifacts under .scratch/ or tool-owned artifact directories.
- Do not weaken auth, permissions, validation, encryption, rate limits, or auditability.
- Do not manually edit generated files unless the repo requires it.
- Do not stage, commit, amend, rebase, reset, stash, push, or delete files unless explicitly asked.

## Decision Rules

- Execute obvious low-risk solutions.
- Present up to two options when material product or architecture tradeoffs exist.
- Proceed with safe assumptions and state them in the final report.
- Ask before destructive, irreversible, security-sensitive, privacy-sensitive, or unrelated-user-affecting actions.

## Completion Protocol

At the end of implementation or investigation, report:

- what changed and why;
- root cause when identified;
- affected layers;
- validation performed;
- Primary signal status: met, not met, or partially validated;
- Secondary signal status: exact checks run and what they showed;
- documentation status;
- remaining risks or follow-up work;
- migration or rollout implications when relevant;
- concise suggested commit message.

<!-- SPECKIT START -->
For additional context about technologies to be used, project structure,
shell commands, and other important information, read the current plan
at `specs/001-hyperliquid-tracker-branches/plan.md`
<!-- SPECKIT END -->
