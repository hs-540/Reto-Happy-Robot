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
- **Never add attribution lines of any kind**: no `Co-authored-by:`, no `Generated with`, no `🤖`, no Claude/AI/sign-off/`Refs:` trailers. The commit message is exactly `<type>: <message>` and nothing else.

## Steps

1. Run `git status` and `git diff --stat` (both staged and unstaged) to see what changed.
2. If there are unstaged changes, you MUST use the `AskUserQuestion` tool to ask whether to commit **all** changed files or **only** what's already staged — do not assume or infer the answer, and do not skip this by reasoning about it in text. Skip the question only if everything is already staged (nothing unstaged) — in that case just commit what's staged. If nothing is staged and there are unstaged changes, still use `AskUserQuestion`, asking which files to include (committing nothing isn't an option).
3. Pick the right `type` based on the nature of the change.
4. Draft a message under 60 chars total, in English, preserving domain-specific terms as-is.
5. Stage the relevant files according to the user's answer (avoid `git add -A`; add specific paths).
6. Commit with the message exactly as drafted — never append co-author or AI attribution trailers.
7. Run `git status` to confirm the commit succeeded.

## Examples

- `feat: add booking confirmation endpoint`
- `fix: prevent duplicate incidente entries`
- `data: add historical incidentes datasets`
- `docs: document apagón-madrid scenario`
- `chore: remove unused .gitkeep placeholders`
