# Implementation handoff

For ordinary implementation work, finish with committed and pushed changes,
a focused PR, independent Standards and Spec reviews, and successful required
checks on the current PR head. Return the PR link, the exact verified revision,
both review outcomes and any remaining blocker. A blocked task can be handed
back with an explicit blocker; do not describe it as ready. Merge and deployment
require their own authorization.

Honor the user's requested endpoint. Local-only work does not require a PR;
report the delivered content and applicable local checks. A historical review
names its comparison base/head and review outcomes without requiring current
main. After an authorized merge, verify the resulting commit's own checks;
PR-head checks do not establish post-merge verification.

## PR report

From the checkout, with Node, Git and authenticated GitHub CLI available:

```sh
npm run --silent handoff -- --pr 123 --reviews /tmp/hearth-review.json
npm run --silent handoff -- --pr 123 --reviews /tmp/hearth-review.json --json
```

The PR number is explicit. The repository defaults to the GitHub `origin` URL;
`--repo owner/name` selects it explicitly. Reporting a different repository still
shows its PR observations, but does not declare the local checkout to match it.
The command reads Git and GitHub; it does not fetch, push, edit source, merge,
deploy, run tests or post comments. It takes one snapshot with a 30-second total
subprocess deadline, including timeout cleanup. Each invocation may make
multiple read-only API requests.
Use existing `gh` check commands with bounded waits when checks are pending,
then rerun the report. On timeout or interruption, the reporter terminates each
active command's original process group and closes its output readers. It bounds
direct-child cleanup without waiting for output EOF from escaped descendants.
It does not discover or terminate descendants that started a separate session.

The agent prepares the review file from the independent reviewers' results,
outside the source checkout. The user does not need to transcribe it. Example
structure (replace the SHA placeholders with full 40-character commit IDs):

```json
{
  "base": "<actual comparison-base SHA>",
  "head": "<reviewed PR-head SHA>",
  "standards": {
    "reviewer": "<Standards reviewer identity or source>",
    "outcome": "pass",
    "unresolvedFindings": []
  },
  "spec": {
    "reviewer": "<different Spec reviewer identity or source>",
    "outcome": "pass",
    "unresolvedFindings": []
  }
}
```

`base` is the actual merge-base used for the reviewed diff, not a branch name.
Record it when reviewing, along with the exact head. Both outcomes must be
`pass` with no unresolved findings and different reviewer identities. Use
`fail` and list remaining findings otherwise. These are supplied assertions:
the reporter checks their structure and revisions, not the quality or
independence of the underlying review. A changed head requires new review
assertions. A target advance affects freshness; it invalidates review evidence
when the comparison changes.

The report separates local/remote observations, required check results,
GitHub merge eligibility and supplied review assertions. Required checks come
from effective branch rules plus classic protection, including their required
app identities. Skipped or neutral checks may satisfy GitHub, but do not count
as successful execution for handoff readiness. A green check in one suite does
not hide a conflicting result in another suite. API failures or incomplete
responses remain unknown. The report is a bounded observation, not a lock on
GitHub state; rerun it after changes and before acting on it.

Exit status:

- `0`: ready for PR handoff. The checkout matches the PR head and is clean;
  checks and current review assertions pass; freshness, policy and GitHub merge
  eligibility are established.
- `1`: a known requirement is unmet, including pending/missing/failed checks,
  a draft/closed PR, stale review evidence or uncommitted changes.
- `2`: readiness cannot be established, for example due to missing review
  evidence, unreadable policy, an API error or a changing snapshot.
- `130`: interrupted.

If known blockers and unknowns coexist, exit `1` reports the known blocker;
the text and JSON retain every unknown as well. A ready report is not merge
or deployment authorization.

This version conservatively blocks on all tracked or non-ignored untracked
changes. It preserves them and makes no claim about task ownership. Ignored
configuration and external inputs are outside its local-state coverage. Local
checks remain governed by [verification guidance](verification.md); they are
not re-executed or inferred by the reporter. Local-only and historical tasks
use the handoff guidance above, rather than the open-PR command.
