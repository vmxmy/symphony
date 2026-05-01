# Upstream Sync

This fork tracks `openai/symphony` for engine updates. The fork's added
surfaces (`bin/`, `profiles/`, `docs/`, `PRODUCT.md`, `.gitignore`) live
**outside** `elixir/lib/`, so upstream merges should be conflict-free except
for occasional `README.md` overlap.

## One-time setup

```bash
cd /Users/xumingyang/github/symphony
git remote add upstream https://github.com/openai/symphony.git
git remote -v
# origin    <your fork>             (push/fetch)
# upstream  https://github.com/openai/symphony.git  (fetch)
```

## Pull upstream updates

```bash
git fetch upstream
git log HEAD..upstream/main --oneline   # see what changed
git merge upstream/main
```

If `elixir/WORKFLOW.upstream.md` (the original WORKFLOW.md we renamed) gets
upstream changes, decide whether to incorporate them into per-profile
`WORKFLOW.md` files.

## Conflict-prone files

| Path | Reason |
|---|---|
| `README.md` | We may want our own intro at the top |
| `elixir/WORKFLOW.upstream.md` | Renamed, but upstream may still update `elixir/WORKFLOW.md` and the merge has nowhere to land it |
| `AGENTS.md` | Upstream may update orchestration guidance |

Strategy: keep upstream contents intact under their original paths, prefix
our additions clearly. Use `git diff upstream/main -- elixir/lib/` after merge
to verify engine code is in sync.

## Pinning a known-good upstream commit

In any release tag we cut on this fork, record the upstream commit:

```
docs/upstream-sync.md
  Last upstream merge: <commit-sha> (<date>)
```

This makes "engine version" recoverable from the fork's git history.

### Current pin

- **Last upstream merge**: (record after first `git merge upstream/main`)
- **Verified compatible**: launcher v1.0.0, profile schema v1
