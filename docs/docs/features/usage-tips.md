# Dashboard Usage Tips

A compact strip beneath historical dashboard statistics links to documented ProPR capabilities. A worker ranks installation-relevant tips approximately once a day using the repository indexing agent and its configured fallback. Each tip explains why it fits your workflow using observed activity in your instance, suggests a documented action, and describes how it could help. These recommendations use installation-wide signals, not individual activity histories. If model generation fails, signal-based recommendations still explain the context and benefit. No extra model setting is needed. Up to three eligible tips appear; fewer or none is normal.

## Goals and launch strategies

Goals support two launch strategies: **Agent implements directly** opens a draft PR and commits changes at checkpoints; **Agent orchestrates through ProPR** lets the agent decompose work, create issues, and start and monitor their implementation. Use Goals for an ongoing objective and Planner Studio when you want to inspect and refine a plan before running it.

## Temporary dismissal

Dismissals belong to your user account. Dismissing a tip hides it immediately and starts a cooling-off period. At the default 45 days, successive deliberate dismissals cool down for **45, 180, 720, and 2,880 days**. Further growth is capped at **3,650 days**. Expiry retains the lifetime dismissal count. A tip becomes eligible exactly at the cooldown boundary, but only appears if it remains relevant in the current selection. New relevance never overrides an active cooldown.

Settings → Automation exposes **Usage tips** (enabled by default) and **Dismissal cooldown days** (an integer from 1 to 365, default 45). Changing the base period recalculates existing cooldowns from each stored dismissal timestamp and lifetime count. Disabling tips hides the strip and stops daily selection.

The CLI exposes the same settings:

```sh
propr setting update usage_tips_enabled false
propr setting update usage_tips_dismissal_cooldown_days 60
```

A failed dismissal is retried with the same event identifier. If persistence still fails, the tip returns with a quiet retry control. Duplicate delivery never increases the count or restarts the cooldown.

## Relevance and privacy

The daily job uses guarded aggregate feature-usage signals; unavailable signals remain unknown. Features already used regularly are excluded. Candidates rotate deterministically within ten-point relevance bands, without displacing higher-band tips. The saved order remains stable across reloads, and a single relevant tip can recur daily.

**Display history is not tracked.** Rendering, mounting, reloading and reading tips record no impressions, display counts, first/last-shown timestamps, or acknowledgements. Only an explicit dismissal records acknowledgement. Previous selection does not make a tip ineligible.

The committed catalog is generated from documentation with `npm run tips:generate`. Its stable identities survive wording changes, preserving dismissal history. Runtime services import the catalog and never read the documentation tree.
