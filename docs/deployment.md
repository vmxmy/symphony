# Deployment

The launcher + Symphony engine + at least one profile is enough for local
operation. For pipelines that depend on **fixed-IP egress** (e.g., WeChat API
IP whitelist) a small VPS is needed for the affected stages.

## Local-only profiles

If your pipeline does not need fixed-IP egress, no extra deployment is needed:

```bash
./bin/symphony-launch start <profile>
```

The Symphony engine, Codex, all skills run on your local machine. Workspaces
and archives live under `~/symphony-content-workspaces/` and
`~/symphony-content-archive/` (or whatever the profile's `workspace_root` /
`archive_root` declare).

## Fixed-IP VPS (for WeChat / regulated APIs)

WeChat 公众号 API requires the caller's egress IP to be in a whitelist.
Local Mac ISPs typically rotate IPs daily, so we delegate the publishing call
to a small VPS with a static IP.

### VPS requirements

- Linux (Ubuntu 22+ tested)
- Ubuntu user `dev` with passwordless sudo
- SSH key auth from the local machine
- Public IPv4 (added to WeChat 公众号 IP 白名单)
- Tools: `bun`, `node`, `curl`, `python3` (auto-installed if missing)

### One-time provisioning (per VPS)

```bash
ssh dev@<vps-host>

# bun (TS runtime for baoyu-* skills)
curl -fsSL https://bun.sh/install | bash

# WeChat skill
mkdir -p ~/.codex/skills ~/.baoyu-skills
exit
```

From local:

```bash
# sync the publishing skill
rsync -av profiles/<profile>/skills/baoyu-post-to-wechat/ \
  dev@<vps-host>:~/.codex/skills/baoyu-post-to-wechat/

# sync credentials
scp profiles/<profile>/env dev@<vps-host>:~/.baoyu-skills/.env
ssh dev@<vps-host> 'chmod 600 ~/.baoyu-skills/.env'
```

### Whitelist the VPS IP

Get the VPS public IP:
```bash
ssh dev@<vps-host> 'curl -s -4 https://api.ipify.org'
```

Add it to **公众号后台 → 设置与开发 → 基本配置 → IP 白名单**.

### How the launcher uses it

The profile's `WORKFLOW.md` Stage 6 (Publishing) issues commands like:

```bash
ssh dev@74.48.189.45 '
  set -a; source ~/.baoyu-skills/.env; set +a
  export PATH="$HOME/.bun/bin:$PATH"
  cd ~/symphony-content-workspaces/<issue>
  bun ~/.codex/skills/baoyu-post-to-wechat/scripts/wechat-api.ts ...
'
```

So the agent (running locally) only **shells out** to the VPS for the final
WeChat API call. Everything else (research, drafting, image gen) stays local.

### Path translation note

HTML produced locally contains `data-local-path` attributes pointing to Mac
absolute paths. Stage 6.2 of the profile's WORKFLOW.md does a `sed`
translation before calling `wechat-api.ts` on the VPS:

```bash
sed -i 's|/Users/xumingyang/symphony-content-workspaces|/home/dev/symphony-content-workspaces|g' \
  output/final.vps.html
```

The launcher itself does not do this — it lives in the profile's WORKFLOW.md
because path layouts are profile-specific.

---

## Multi-profile concurrency

You can run multiple profiles in parallel as long as they have different
`symphony.port` values. The launcher manages each profile's PID independently.

```bash
./bin/symphony-launch start content-wechat       # :4001
./bin/symphony-launch start contract-review      # :4002 (when added)
./bin/symphony-launch list
```

Each profile has its own:
- HTTP/dashboard port
- Workspace root (`~/symphony-content-workspaces` vs `~/symphony-contract-workspaces`)
- Archive root
- CODEX_HOME (so sessions don't intermix)
- Log root (`profile/runtime/log/`)

---

## Production hardening (out of scope for v1)

- Process supervision (systemd / launchd)
- Log rotation
- Healthcheck/alerting
- Multi-machine load distribution

These are reasonable v1.x / v2.0 additions. Current deployment is
**single-host, foreground (nohup), per-profile**.
