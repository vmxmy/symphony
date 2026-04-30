# content-wechat profile

Self-contained Symphony profile for producing 1500-2200 字 articles for a single
WeChat Official Account, with reviewer gates and SSH-worker publishing.

## Pipeline

```
Backlog (策划) → Todo → Researching → Outlining → Drafting → Self-Editing
              → [Draft Review] → Rendering → [Final Review] → Publishing → Done
```

`[]` are PAUSE states (human review). All other active states are agent-driven.

Publishing runs over SSH to a fixed-IP VPS (default `dev@74.48.189.45`) so the
WeChat IP whitelist works regardless of the local Mac's dynamic ISP IP.

## Setup (first time)

```bash
# 1. Fill credentials
cp env.example env
$EDITOR env  # set LINEAR_API_KEY, WECHAT_APP_ID, WECHAT_APP_SECRET

# 2. Provision VPS (one-time per machine)
ssh dev@74.48.189.45 'curl -fsSL https://bun.sh/install | bash'
rsync -a skills/baoyu-post-to-wechat/ dev@74.48.189.45:~/.codex/skills/baoyu-post-to-wechat/
scp env dev@74.48.189.45:~/.baoyu-skills/.env

# 3. Add VPS public IP (74.48.189.45) to WeChat 公众号 IP 白名单
#    设置与开发 -> 基本配置 -> IP 白名单

# 4. Launch
~/symphony-profiles/bin/symphony-launch start content-wechat
```

## Daily use

```bash
# Start the orchestrator
symphony-launch start content-wechat

# Watch dashboard
open http://127.0.0.1:4001/

# Stop
symphony-launch stop content-wechat

# Restart (to pick up WORKFLOW.md changes)
symphony-launch restart content-wechat
```

## Creating a Linear issue

In the linked Linear project (slug `ziikoo-839b53546018`):
- Title: 文章主题
- Description: 写作要求 (目标读者, 字数, 风格, 必须涉及, 不要)
- Label: 科普 | 速报 | 评论 | 教程 (one of)
- State: Todo

Symphony picks up within ~10 seconds and runs through the pipeline.

## Files

| Path | Purpose |
|---|---|
| `profile.yaml` | Profile metadata + Linear/Symphony/preflight config |
| `WORKFLOW.md` | Symphony pipeline definition (state machine + prompt body) |
| `env` | API credentials (gitignored) |
| `env.example` | Credentials template (committed) |
| `skills/` | All skills this profile uses (self-contained) |
| `codex-home/` | Per-profile CODEX_HOME with skills + symlinks to system config |
| `runtime/` | PID file + logs + sessions (per profile) |

## Portability

This profile is fully self-contained. To move to another machine:

```bash
tar czf content-wechat-1.0.0.tar.gz \
  --exclude=runtime --exclude=env \
  ~/symphony-profiles/content-wechat
scp content-wechat-1.0.0.tar.gz another-host:~/
ssh another-host 'cd ~ && tar xzf content-wechat-1.0.0.tar.gz \
  && mv symphony-profiles/content-wechat ~/symphony-profiles/'
ssh another-host 'cp ~/symphony-profiles/content-wechat/env.example \
  ~/symphony-profiles/content-wechat/env'
# fill in env on remote, then symphony-launch start
```

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `40164: invalid ip` from WeChat | VPS IP not whitelisted | Add 74.48.189.45 in WeChat 公众号后台 |
| `Could not resolve host: api.weixin.qq.com` | Local Mac sandbox blocks DNS | Should not happen with `--dangerously-bypass-approvals-and-sandbox`; verify `codex.command` flag in WORKFLOW.md |
| Agent stuck in retry loop | Pre-Stage 6.0 Symphony version | Update WORKFLOW.md to current Stage 6 with VPS-based publish + fail-fast |
| `Image not found` in publish output | HTML data-local-path uses Mac path | Stage 6.2 sed translation; check `output/final.vps.html` exists |
