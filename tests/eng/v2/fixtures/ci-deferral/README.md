# Real draft-deferral fixture (SHEP-LATEST-01 PR2)

Captured read-only from a real DRAFT-DEFERRED run of draft PR #1441 (run 43459049109, head c1e77f71a8b0965f06ffe7b76684473c0f615619, event pull_request). Files are byte copies of the GitHub REST responses (`actions/runs/{id}` and `actions/runs/{id}/jobs`); nothing was edited.

DEPENDENCY: this fixture reflects the aggregator split of #1441 (steps `Fail closed on prerequisites`, `DRAFT-DEFERRED`, `Aggregate browser shard results`), which is NOT on production when this fixture is added. Until #1441 merges, nothing in this repository's ci.yml produces these steps; PR3 (the reader) must not merge before #1441, and cross-checks the step names against ci.yml once it does.

Runner-added steps: the job listing also carries `Set up job` first and `Complete job` last. A deferral predicate must accept `Set up job` among the "earlier steps all successful", and `Complete job` = success among the "later steps skipped". The real order is: 1 Set up job success, 2 Fail closed on prerequisites success, 3 DRAFT-DEFERRED failure, 4 Aggregate browser shard results skipped, 5 Complete job success.

Also real: a skipped matrix job keeps its unrendered name (`browser shard ${{ matrix.shard }} (...)`), and its `steps` is empty.
