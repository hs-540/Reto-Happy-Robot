---
name: commiting
description: Create a git commit with a conventional-style, English message ("type: message" under 60 chars). Use whenever the user asks to commit changes in this repo.
---

# Commiting

Create a git commit whose message follows this project's convention.

## Message format

`<type>: <message>`

- `type`: one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`, `ci`, `build` — pick the one that best matches the change.
- `message`: imperative, lowercase, in **English**, **under 60 characters** total (including the `type: ` prefix).
- Keep domain/business terms (e.g. proper nouns, entity or scenario names from the business domain like `apagón-madrid`, `subestación`) in their original language — do not translate them.
- No body, no bullet points, no trailing period, unless the user explicitly asks for more detail.

## Steps

1. Run `git status` and `git diff --stat` (both staged and unstaged) to see what changed.
2. If there are unstaged changes, ask the user whether to commit **all** changed files or **only** what's already staged. Skip this question if everything is already staged, or if nothing is staged and there are unstaged changes (ask which files to include, since committing nothing isn't an option).
3. Pick the right `type` based on the nature of the change.
4. Draft a message under 60 chars total, in English, preserving domain-specific terms as-is.
5. Stage the relevant files according to the user's answer (avoid `git add -A`; add specific paths).
6. Commit with the message, following the repo's attribution rules if any apply.
7. Run `git status` to confirm the commit succeeded.

## Examples

- `feat: add booking confirmation endpoint`
- `fix: prevent duplicate incidente entries`
- `data: add historical incidentes datasets`
- `docs: document apagón-madrid scenario`
- `chore: remove unused .gitkeep placeholders`
