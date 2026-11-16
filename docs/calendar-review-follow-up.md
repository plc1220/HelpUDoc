# Calendar review follow-up — issue #111

## Gap addressed

The local Smart Calendar implementation supported meeting reads, editing, briefs and links, but had no opt-in meeting-relative review rule, durable delivery outcome, or automatic post to a selected Team Chat thread. [Issue #111](https://github.com/plc1220/HelpUDoc/issues/111) adds this first rule.

## Use

Open one future timed Google meeting occurrence in Calendar while in a Shared workspace. Under **Review follow-up**, choose a shared artifact, an open Team Chat thread and a lead time. Check **Enable this follow-up** and save. The default Google connection requests calendar-list and event read scopes. Broader editing permissions are an explicit upgrade and are not used by the rule.

Every 30 seconds the backend checks durable enabled rules. Within the lead window, it checks current shared review annotations, tasks and change proposals bound to that file. Only pending workspace-audience review items can appear in the selected thread. Private comments and drafts, meeting title, attendees and other personal calendar details are excluded. No pending items produces a durable `no_pending` outcome without a chat post. A rule makes one check in its due window; it does not watch for later review changes after a terminal outcome.

The UI lists the rule, allows disabling it, and shows delivery history. Rules belong to the opting-in user; the worker rechecks that user is active, has Shared workspace posting rights, and can still read the provider event. The artifact identity and path must still match.

## Delivery and safety

- Rule state lives in `calendar_review_follow_up_rules`; terminal outcomes live in `calendar_review_follow_up_audit`. Provider-cache or grant cleanup does not delete these delivery records.
- Workers lock the rule row. The canonical Team Chat append, terminal audit and rule completion commit in one PostgreSQL transaction. A crash or failed audit insert rolls back the post. A unique rule/occurrence key prevents duplicates across workers, retries and restarts.
- The explicitly selected event reference identifies the occurrence independently of its current start time. Moving it updates the due window. A final fresh event/ACL read catches changes during processing; changed revisions defer delivery to another poll.
- Cancelled, inaccessible, invalid or expired events terminate without a post. Provider outages and stale cache fallbacks remain retryable and never authorize delivery.
- Review file and selected pending review rows are held for reading during the final check and append. Only one internal thread destination exists; the worker has no Calendar mutation, email, external messaging or agent tool interface.

This slice supports one selected timed occurrence from Google. All-day events and recurring series masters are rejected. Repeating a rule for every occurrence, model-generated follow-ups and broader event automations remain outside this issue. As with any external provider, a change after the final provider read cannot be made atomic with the local database commit.

## Verification

Run against an isolated test database (the tests create and remove a unique schema):

```sh
cd backend
RUN_CALENDAR_REVIEW_TESTS=1 CALENDAR_REVIEW_DATABASE_URL=postgresql://user:password@127.0.0.1:5432/test_db \
  node -r ts-node/register/transpile-only -r tsconfig-paths/register --test tests/calendarReviewFollowUp.test.ts
```

The suite uses a fixed clock, a fake Calendar provider, real workspace authorization, PostgreSQL transactions and the canonical Team Chat store. It covers duplicate/concurrent deliveries, retries, separate worker process restarts, post/audit rollback, moved/cancelled/revoked events, event changes between reads, deactivated users, private review exclusion, destination isolation and public route guards. It never contacts real calendar accounts or external destinations.

`calendar-review-tests` is required by the existing `ci-gate` for relevant backend PRs and default-branch pushes. The reusable `calendar-review-follow-up.yml` workflow also runs nightly and manually; those executions build the backend image and repeat the synthetic restart suite inside it. Repository branch protection remains an administrator setting. Local built-image execution was unavailable during implementation because the Docker runtime could not start; this is not claimed as completed release acceptance.
