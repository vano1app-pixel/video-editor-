---
name: board
description: Run the review board over the current work — routes to the reviewers that actually apply (ceo, designer, engineer, security, counsel, qa) and returns one merged verdict. Use when the user asks for a review, says "run the board", or before shipping anything public-facing. Also triggered by the review policy in CLAUDE.md.
---

# The review board

Fan out to the specialist reviewers that apply to *this* change, then merge their findings into one verdict the user can act on.

## Step 1 — see what actually changed

Do not route from memory of the conversation. Look:

```
git status --short
git diff --stat HEAD
```

For uncommitted work, `git diff`. For a branch, `git diff main...HEAD`.

## Step 2 — route

Only call reviewers whose trigger is present. Reviewing a typo fix with six agents is expensive and trains the user to ignore the output.

| Reviewer | Call it when the change touches |
| --- | --- |
| `engineer` | any non-trivial logic — always, unless the change is purely copy or docs |
| `designer` | anything a user sees: markup, styles, generated images, user-facing copy |
| `security` | payments, secrets, auth, uploads, personal data, anything reachable from the internet |
| `counsel` | public launch, taking money, storing other people's data, marketing claims, third-party platform automation |
| `qa` | a runnable feature changed, or tests were added or edited |
| `ceo` | new feature, pricing, or a change of direction — not bug fixes |

Two or three reviewers is the common case. All six is rare and should be reserved for a launch.

**Launch a whole round in a single message with multiple Agent calls** so they run concurrently. Give each one the diff scope and the specific question you want answered — a reviewer with no brief returns generic advice.

## Step 3 — verify before reporting

Findings arrive as claims, not facts. Before passing one to the user:

- If it names a file and line, open it and confirm the code says what the reviewer thinks.
- If it claims a runtime failure, reproduce it.
- Drop anything you cannot substantiate, and say how many you dropped.

Reviewers disagreeing is normal and useful — the designer wanting motion and the engineer wanting less code are both right about their own dimension. Surface the trade-off; don't average it away.

## Step 4 — one merged verdict

Report in this shape:

1. **Ship / don't ship**, and the single reason.
2. **Blockers** — would cause real damage. File, line, what breaks.
3. **Worth fixing now** — cheap and clearly right.
4. **Noted, not now** — real but not urgent, so the user can stop thinking about it.
5. **Disagreements** — where two reviewers pulled opposite ways, and your recommendation.

Attribute findings to the reviewer that raised them, so the user can weigh them.

Nothing found is a valid outcome. Say so in a line rather than manufacturing a list.

## Applying fixes

Fix the blockers you're confident about, then re-report with what changed. Ask first when a fix is architectural, changes a decision the user already made, or would take real time. Never apply a fix you cannot verify.
