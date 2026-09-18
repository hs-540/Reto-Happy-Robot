---
name: creating-pr
description: Push the current branch and open a GitHub pull request, following this project's title/description conventions (same types as the commiting and branching-setup skills). Use whenever the user asks to create, open, or submit a PR.
---

# Creating pull requests

Open a pull request for the current branch against `main`, using `gh`, kept consistent with the `commiting` and `branching-setup` skills.

## PR title format

`<type>: <message>`

- `type`: one of `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`, `ci`, `build` — same set used by the `commiting`/`branching-setup` skills, pick the one that best matches the overall change.
- `message`: imperative, lowercase, in **English**, under ~70 characters.
- Keep domain/business terms (e.g. `apagón-madrid`, `subestación`) in their original language — do not translate them.

## PR body format

```
## Summary
- <1-3 bullet points on what changed and why>

## Test plan
- [ ] <bulleted checklist of how this was/should be verified>
```

- Written in English, concise, no fluff.
- Base the summary on the actual commits/diff in the branch, not just the latest commit.
- End the body with the attribution line given in this conversation's system reminder, when one is present.

## Steps

1. Run `git status`, `git log main..HEAD` (or the relevant base branch) and `git diff main...HEAD` to see the full set of commits and changes going into the PR — not just the latest commit.
2. Check whether the current branch has an upstream: `git status -sb` or `git rev-parse --abbrev-ref --symbolic-full-name @{u}` (ignore errors, it just means no upstream yet).
3. If there are uncommitted changes, warn the user and ask whether to commit them first (use the `commiting` skill), stash, or continue anyway — do not assume.
4. Push the branch:
   - No upstream yet: `git push -u origin <branch-name>`.
   - Upstream exists: `git push`.
5. Draft the PR title and body per the formats above, based on all commits in the branch.
6. Create the PR with `gh pr create --title "<type>: <message>" --body "$(cat <<'EOF' ... EOF)"`, targeting `main` unless the user says otherwise.
7. Return the PR URL from `gh pr create`'s output.

## Notes

- Never force-push as part of this skill.
- If `gh` is not authenticated, tell the user to run `gh auth login` rather than trying to work around it.
- Do not merge the PR — this skill only opens it.

## Examples

- `feat: add booking confirmation endpoint`
- `fix: prevent duplicate incidente entries`
- `docs: document apagón-madrid scenario`
- `chore: add branching-setup skill`
