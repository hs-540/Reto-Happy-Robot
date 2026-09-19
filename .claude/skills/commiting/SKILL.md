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
- Write the message fully in English, consistent with the repo's English-only rule.
- No body, no bullet points, no trailing period, unless the user explicitly asks for more detail.
- **Never add attribution lines of any kind**: no `Co-authored-by:`, no `Generated with`, no `🤖`, no Claude/AI/sign-off/`Refs:` trailers. The commit message is exactly `<type>: <message>` and nothing else.

## Steps

1. Run `git status` and `git diff --stat` (both staged and unstaged) to see what changed.
2. If there are unstaged changes, you MUST use the `AskUserQuestion` tool to ask whether to commit **all** changed files or **only** what's already staged — do not assume or infer the answer, and do not skip this by reasoning about it in text. Skip the question only if everything is already staged (nothing unstaged) — in that case just commit what's staged. If nothing is staged and there are unstaged changes, still use `AskUserQuestion`, asking which files to include (committing nothing isn't an option).
3. Pick the right `type` based on the nature of the change.
4. Draft a message under 60 chars total, in English, writing everything in English.
5. Stage the relevant files according to the user's answer (avoid `git add -A`; add specific paths).
6. Commit with the message exactly as drafted — never append co-author or AI attribution trailers.
7. Run `git status` to confirm the commit succeeded.

## Examples

- `feat: add booking confirmation endpoint`
- `fix: prevent duplicate incidente entries`
- `data: add historical incidentes datasets`
- `docs: document madrid-blackout scenario`
- `chore: remove unused .gitkeep placeholders`
