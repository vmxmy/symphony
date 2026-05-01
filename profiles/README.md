# Profiles

Each subdirectory here is a self-contained Symphony pipeline.

| Profile | Purpose | Status |
|---|---|---|
| `content-wechat/` | WeChat 公众号 1500-2200 字 科普/速报/评论/教程 | active |
| `_template/` | Skeleton for new profiles | template |

## Structure

See [../docs/profile-spec.md](../docs/profile-spec.md) for the full
`profile.yaml` schema and required directory layout.

## Lifecycle

1. **Create**: copy `_template/` to a new dir, edit `profile.yaml` and `WORKFLOW.md`
2. **Configure**: `cp env.example env`, fill credentials
3. **Validate**: `../bin/symphony-launch check <name>`
4. **Run**: `../bin/symphony-launch start <name>`

## What's gitignored

| Path | Why |
|---|---|
| `*/env` | API credentials |
| `*/runtime/` | PID, logs, sessions (per-machine state) |
| `*/codex-home/sessions/` | Codex conversation history |
| `*/codex-home/generated_images/` | image_gen output |
| `*/codex-home/auth.json` | Per-machine Codex auth (symlink to `~/.codex/auth.json`) |

## What's committed

`profile.yaml`, `WORKFLOW.md`, `README.md`, `env.example`, `skills/` (entire
trees), `codex-home/config.toml` and `codex-home/skills/*` symlinks.

## Naming convention

- Use lowercase + dash separator (e.g., `content-wechat`, not `ContentWechat`)
- Names starting with `_` (like `_template`) are hidden from `symphony-launch list`
