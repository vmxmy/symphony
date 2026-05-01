---
name: debug
description:
  Investigate stuck runs and execution failures by tracing Symphony and Codex
  logs with issue/session identifiers; use when runs stall, retry repeatedly, or
  fail unexpectedly.
---

# Debug

## Goals

- Find why a run is stuck, retrying, or failing.
- Correlate Linear issue identity to a Codex session quickly.
- Read the right logs in the right order to isolate root cause.

## Log Sources

- Profile runtime log: `profiles/<name>/runtime/log/symphony.log*`
- Launcher output: `profiles/<name>/runtime/log/launcher.out`
- Custom logs root: whatever was passed with `--logs-root`

## Correlation Keys

- `issue_identifier`: human ticket key, for example `MT-625`
- `issue_id`: Linear UUID
- `session_id`: Codex session/thread identifier when emitted by the adapter

## Quick Triage

1. Confirm scheduler/worker symptoms for the ticket in the dashboard or `/api/v1/state`.
2. Find recent lines for the ticket using `issue_identifier` first.
3. Extract `session_id` if present.
4. Trace that `session_id` across start, stream, completion/failure, and retry logs.
5. Classify failure: timeout/stall, app-server startup, turn failure, tool failure, or orchestrator retry loop.

## Commands

```bash
# Narrow by ticket key
rg -n "issue_identifier=MT-625|MT-625" profiles/*/runtime/log/*.log*

# Narrow by Linear UUID
rg -n "issue_id=<linear-uuid>" profiles/*/runtime/log/*.log*

# Pull session IDs
rg -o "session_id=[^ ;]+" profiles/*/runtime/log/*.log* | sort -u

# Trace one session
rg -n "session_id=<session-id>" profiles/*/runtime/log/*.log*

# Focus on stuck/retry signals
rg -n "stalled|retry|turn_timeout|turn_failed|Codex session failed|ended with error" profiles/*/runtime/log/*.log*

# Inspect live API state
curl -s http://127.0.0.1:<port>/api/v1/state | python3 -m json.tool | head -80
```

## Investigation Flow

1. Locate the ticket slice.
2. Establish the timeline: dispatch -> workspace -> Codex session -> tool calls -> completion/error.
3. Classify the problem and whether it is isolated to one issue or systemic.
4. Capture evidence with timestamps, issue key, issue UUID, and session ID.
5. Record probable root cause and exact failing stage.

## Notes

- Prefer `rg` over `grep` for speed on large logs.
- Check rotated logs before concluding data is missing.
- Pair `session_id` with `issue_identifier`/`issue_id` to avoid mixing concurrent runs.
