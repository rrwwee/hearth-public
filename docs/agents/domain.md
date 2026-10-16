# Domain Docs

This repo uses a single-context layout: `CONTEXT.md` at the repo root and architecture decision records in `docs/adr/`.

## Before exploring, read these

- Root `CONTEXT.md` for the domain glossary and model.
- ADRs in `docs/adr/` that touch the area you are about to work in.

If these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. The `/domain-modeling` skill (also reached through `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When naming a domain concept in an issue title, refactor proposal, hypothesis, or test name, use the term defined in `CONTEXT.md` and respect any synonyms it explicitly avoids.

If a needed concept is absent, reconsider whether the project uses that concept or note the real gap for `/domain-modeling`.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, identify the ADR explicitly and explain why the decision is worth reopening.
