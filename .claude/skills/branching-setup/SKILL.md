---
name: branching-setup
description: Create a new git branch quickly, following this project's "<type>/<short-description>" naming convention (same types as the commiting skill). Use whenever the user asks to create, start, or check out a new branch.
---

# Creating branches

Create a new git branch following this repo's naming convention, kept consistent with the `commiting` skill's commit types.

## Branch name format

`<type>/<short-description>`

- `type`: one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`, `ci`, `build` — same set used by the `commiting` skill, pick the one that best matches the work.
- `short-description`: kebab-case, in **English**, a few words max — no verbs like "add-the", just the essence.
- Keep domain/business terms (e.g. proper nouns, scenario names like `apagón-madrid`, `subestación`) in their original language and form, but still kebab-case them (`apagon-madrid`, no accents/spaces since git refs can't hold them well — drop diacritics, keep the term recognizable).

## Steps

1. Run `git status` — if there are uncommitted changes, warn the user and ask whether to stash them, commit them first, or continue anyway (creating a branch keeps uncommitted changes, but confirm intent rather than assuming).
2. You MUST use `AskUserQuestion` to ask whether the new branch should start from an **updated `main`** or from the **current branch** — never assume either.
   - If updated `main`: `git fetch origin main && git checkout main && git pull` before branching off.
   - If current branch: skip the fetch/checkout, branch off directly from where the user is standing.
3. Infer the `type` and a short description from what the user describes wanting to work on (ask only if genuinely ambiguous).
4. Create and switch to the branch: `git checkout -b <type>/<short-description>`.
5. Run `git status` to confirm the branch was created and is checked out.

## Examples

- `feat/booking-endpoint`
- `fix/duplicate-incidente-entries`
- `docs/apagon-madrid-scenario`
- `chore/remove-unused-gitkeep`
