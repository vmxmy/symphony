# Launcher CLI Reference

The launcher (`bin/symphony-launch`) is the user-facing tool for managing
profile-driven Symphony instances.

## Auto-detected paths

Run from `<repo>/bin/symphony-launch` (or via PATH symlink). The script resolves
its own location and derives:

- `REPO_ROOT`     = `<launcher>/..`
- `SYMPHONY_BIN`  = `$REPO_ROOT/bin/symphony`
- `PROFILES_ROOT` = `$REPO_ROOT/profiles`

Override with env vars when needed:

```bash
SYMPHONY_BIN=/custom/path/symphony \
SYMPHONY_PROFILES_ROOT=~/my-profiles \
  symphony-launch list
```

## Commands

### `list`
Show all profiles in `PROFILES_ROOT` and their RUNNING/stopped status.

```
$ symphony-launch list
Repo:     /Users/x/github/symphony
Profiles: /Users/x/github/symphony/profiles
Engine:   /Users/x/github/symphony/bin/symphony

  NAME             STATUS   PORT    DESCRIPTION
  ----             ------   ----    -----------
  content-wechat   RUNNING  :4001   WeChat 公众号 ...
```

Profile names starting with `_` are hidden (used for templates).

### `check <profile>`
Run preflight without starting Symphony. Validates:
1. Symphony binary exists and is executable
2. `profile.yaml` present
3. `WORKFLOW.md` present and YAML frontmatter parses
4. `env` file present and sourceable
5. All `preflight.env_required` vars are set after sourcing env
6. All `preflight.skills_required` directories exist under `skills/`
7. `codex-home/{config.toml,auth.json,skills}` all exist

Exit code 0 = pass, 1 = fail.

### `start <profile>`
Run preflight, then spawn Symphony detached:

1. `set -a; source profile/env`
2. `export CODEX_HOME=profile/codex-home`
3. `mkdir -p` workspace_root + runtime/log + runtime/sessions
4. Build engine command:
   ```
   <SYMPHONY_BIN> profile/WORKFLOW.md \
     --port <symphony.port> \
     --logs-root profile/runtime/log \
     [--i-understand-...]   # if symphony.bypass_guardrails
   ```
5. Write PID to `profile/runtime/symphony.pid`
6. Poll `http://127.0.0.1:<port>/api/v1/state` up to 20s

If Symphony does not become reachable in 20s, the start fails — check
`profile/runtime/log/launcher.out`.

### `stop <profile>`
Read PID from `runtime/symphony.pid`, send `SIGTERM`, wait up to 5s, escalate
to `SIGKILL` if still alive. Removes the PID file.

### `restart <profile>`
`stop` then `start`. State (`profile/runtime/sessions/`, workspaces) is
preserved across restarts.

### `status [profile]`
Without a profile: equivalent to `list`.
With a profile: print PID + port + condensed `/api/v1/state` JSON output.

### `help`
Show usage and the auto-detected paths.

---

## Exit codes

- `0` — success
- `1` — preflight failed / Symphony did not start / unknown command

---

## Logs

Each profile gets its own log root: `profile/runtime/log/`. Symphony's
`--logs-root` writes there; the launcher itself writes `launcher.out` for
spawn-time output.

To tail live:
```
tail -f profiles/content-wechat/runtime/log/symphony.log.1
```

---

## PATH integration

For `symphony-launch` to be callable from anywhere:

```bash
ln -s "$(realpath bin/symphony-launch)" ~/.local/bin/symphony-launch
```

Or add to your shell rc:
```bash
export PATH="$HOME/github/symphony/bin:$PATH"
```

---

## Adding a new profile

For now, manually:

```bash
cp -r profiles/_template profiles/my-pipeline
cd profiles/my-pipeline
$EDITOR profile.yaml WORKFLOW.md env.example
cp env.example env
$EDITOR env
cd ../..
./bin/symphony-launch check my-pipeline
./bin/symphony-launch start my-pipeline
```

(`symphony-launch new` automation is on the roadmap.)
