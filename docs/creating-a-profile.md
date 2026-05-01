# Creating a New Profile

This guide walks you from blank slate to a running pipeline. Read
[architecture.md](architecture.md) and [profile-spec.md](profile-spec.md) first;
this document is the **how-to** companion.

> A profile is one self-contained pipeline (workflow + Linear config + skills
> + credentials + Codex environment). One repo can hold many; they run on
> different ports without interference.

## Table of contents

1. [When to create a new profile vs reuse one](#1-when-to-create-a-new-profile)
2. [The 9-step recipe](#2-the-9-step-recipe)
3. [Designing your state machine](#3-designing-your-state-machine)
4. [Writing WORKFLOW.md](#4-writing-workflowmd)
5. [Choosing skills](#5-choosing-skills)
6. [Setting up CODEX_HOME](#6-setting-up-codex_home)
7. [Linear setup (states + labels)](#7-linear-setup)
8. [Optional: SSH worker for fixed-IP egress](#8-optional-ssh-worker)
9. [Testing the new profile](#9-testing-the-new-profile)
10. [Anti-patterns and known pitfalls](#10-anti-patterns)
11. [Three concrete sketches](#11-three-concrete-sketches)

---

## 1. When to create a new profile

Create a new profile when **any** of these is true:

| Trigger | Why a new profile |
|---|---|
| Different Linear project | profile = 1 Linear project (project_slug binds) |
| Different agent prompt body | WORKFLOW.md per profile; can't share |
| Different skill set | profiles isolate skills via per-profile CODEX_HOME |
| Different credentials (e.g., another WeChat account) | env files don't mix |
| Different concurrency / scheduling | port + workspace_root + max_concurrent_agents differ |
| Different domain / output type | helps mental model and future maintenance |

If you only need a topic variation (e.g., 内容生产 → AI 工具 vs 内容生产 → 商业财经),
that's just **a different Linear issue** in the SAME profile, not a new profile.

---

## 2. The 9-step recipe

Run from the repo root.

```bash
# 1. Pick a name
NAME=contract-review     # lowercase + dash; matches Linear project conceptually

# 2. Copy the template
cp -r profiles/_template profiles/$NAME
cd profiles/$NAME

# 3. Rename the .template files
mv profile.yaml.template profile.yaml
mv WORKFLOW.md.template WORKFLOW.md

# 4. Fill profile.yaml (see §3 + §7 below)
$EDITOR profile.yaml

# 5. Design WORKFLOW.md (see §4)
$EDITOR WORKFLOW.md

# 6. Wire credentials
cp env.example env
$EDITOR env             # add LINEAR_API_KEY + your domain-specific keys
chmod 600 env

# 7. Bundle skills you need (see §5)
mkdir -p skills
cp -r ~/.codex/skills/<some-skill> skills/

# 8. Build codex-home symlink farm (see §6)
mkdir -p codex-home/skills
ln -sf ~/.codex/config.toml codex-home/config.toml
ln -sf ~/.codex/auth.json codex-home/auth.json
ln -sf ~/.codex/skills/.system codex-home/skills/.system
for d in skills/*/; do
  name=$(basename "$d")
  ln -sf "../../skills/$name" "codex-home/skills/$name"
done

# 9. Validate + smoke-launch
cd ../..
./bin/symphony-launch check $NAME
./bin/symphony-launch start $NAME
```

If `check` fails, fix the reported issue and re-check until it passes.
If `start` succeeds, the dashboard is at `http://127.0.0.1:<port>/`.

---

## 3. Designing your state machine

Symphony's state machine has three classes of states (per [architecture.md](architecture.md)):

| Class | Symphony behavior |
|---|---|
| **active** | Symphony dispatches an agent and keeps it running |
| **PAUSE** (in neither active nor terminal) | Agent killed but workspace **kept** for human review |
| **terminal** | Agent killed AND workspace removed (after `before_remove` archives) |

### Two common shapes

**Shape A — single review gate** (simple pipelines, e.g., short news brief):

```
Backlog (策划)
  → Todo (active)
  → In Progress (active)         ← agent does everything
  → Review (PAUSE)                ← you read once
  → Approved (active)             ← agent publishes / commits
  → Done (terminal)
```

**Shape B — multi-stage with intermediate pauses** (long-form content, complex analysis):

```
Backlog
  → Todo
  → Researching (active)
  → Outlining (active)
  → Drafting (active)
  → Self-Editing (active)
  → Draft Review (PAUSE)         ← gate 1
  → Rendering (active)
  → Final Review (PAUSE)          ← gate 2
  → Publishing (active)
  → Done (terminal)
```

The `content-wechat` profile uses Shape B. **Default to Shape A** unless you
need explicit intermediate review gates.

### Naming rules

- Use ASCII names (Chinese state names are valid in Linear but make
  YAML/grep/`linear_graphql` matching harder).
- Prefer noun + gerund: `Researching`, `Reviewing`, `Publishing`.
- Don't reuse names across profiles in the **same Linear team** unless they
  mean exactly the same thing.

### Concurrency control

In `profile.yaml`:

```yaml
agent:
  max_concurrent_agents: 2       # global cap across all states
  max_concurrent_agents_by_state:
    publishing: 1                 # serialize this stage (e.g., API rate limits)
    researching: 5                # IO-heavy, parallel-safe
```

---

## 4. Writing WORKFLOW.md

WORKFLOW.md = YAML frontmatter (engine config) + Liquid prompt body (agent instructions).

### Frontmatter skeleton

```yaml
---
tracker:
  kind: linear
  project_slug: "<your-slug>"
  active_states: [Todo, Researching, Drafting, Publishing]
  terminal_states: [Done, Cancelled, Canceled]
  # PAUSE states (Backlog, Review, Final Review) are NOT listed in either.

polling:
  interval_ms: 8000

workspace:
  root: ~/symphony-<your-domain>-workspaces

hooks:
  after_create: |
    mkdir -p input output
  before_remove: |
    ARCHIVE_ROOT="$HOME/symphony-<your-domain>-archive"
    DEST="$ARCHIVE_ROOT/$(basename "$PWD")-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$DEST"
    cp -r . "$DEST/" 2>/dev/null || true

agent:
  max_concurrent_agents: 2
  max_turns: 15

codex:
  command: codex --dangerously-bypass-approvals-and-sandbox \
    --config shell_environment_policy.inherit=all \
    --config 'model="gpt-5.5"' \
    --config model_reasoning_effort=xhigh \
    app-server
  approval_policy: never
  thread_sandbox: danger-full-access
  turn_sandbox_policy:
    type: dangerFullAccess
---
```

### Prompt body skeleton

```markdown
# <Pipeline name> Agent

You are working on Linear ticket: {{ issue.identifier }}
Current state: {{ issue.state }}

{% if attempt %}
Continuation attempt #{{ attempt }}. First action: read recent comments via
linear_graphql before continuing. Reuse workspace artifacts.
{% endif %}

## Fetch current issue context when needed

The TypeScript engine supports UTF-8 and `{{ issue.* }}` substitutions. For long-running work, still fetch mutable tracker context at runtime when it matters:

1. At the start of a continuation turn, call tracker tools or `linear_graphql` to fetch recent comments.
2. Before state transitions or publishing, re-check title, description, labels, and current state.
3. Treat freshly fetched tracker data as authoritative over stale prompt-rendered context.

## Your workflow (by current state)

### state == "Todo"
1. Use linear_graphql to set state to <first-active-state>.
2. Continue into the next stage.

### state == "<active-state-N>"
... domain-specific instructions ...

### state == "<final-active-state>"
1. Do the publish / commit / handoff action.
2. Use linear_graphql to set state to "Done".

## Hard constraints

- NEVER write outside the workspace cwd
- On any tool error: post error in comment, KEEP state unchanged, end turn
- On continuation (attempt > 1) MUST read comments first via linear_graphql
- <add domain-specific safety rules>
```

### Three frontmatter+body rules to commit to memory

1. **Keep operational keys simple.** YAML keys, state names, and shell-facing paths are easiest to debug when they stay ASCII.
2. **UTF-8 prompt text is supported.** The TypeScript engine uses `yaml` and `liquidjs`, so Chinese prompt bodies and `{{ issue.* }}` substitutions are allowed.
3. **Active vs PAUSE vs terminal states must form a partition.** A state name listed in `active_states` or `terminal_states` is dispatch-eligible or cleanup-eligible respectively. Anything else is a PAUSE point. Misclassifying leads to either runaway agents or stuck workspaces.

---

## 5. Choosing skills

Skills give the agent capabilities beyond bash + linear_graphql.

### Skill discovery

```bash
ls ~/.codex/skills/                 # codex-native + already installed
ls ~/.claude/skills/                # claude-code skills (port via `cp -r`)
```

### Skills relevant by domain

| Domain | Suggested skills |
|---|---|
| Content production | tavily-research, last30days, mptext-api, ljg-writes, ljg-learn, baoyu-format-markdown, baoyu-article-illustrator, baoyu-cover-image, baoyu-markdown-to-html, baoyu-post-to-wechat |
| Investment research | tavily-research, web-access, firecrawl-search, firecrawl-scrape, tushare (financial data), market-research |
| Contract review | firecrawl-scrape (web docs), pdf (parse PDFs), docx (read/write docx), drawio (diagrams) |
| Customer support | mptext-api, baoyu-translate, lark-im (if Lark integration), web-access |
| DevOps / SRE | claude-api or claude-code-guide, baoyu-format-markdown for incident reports |

### Bundling

Each `skills/<name>/` directory must have at least `SKILL.md`. Scripts /
references / prompts subfolders come along automatically with `cp -r`.

### Skills require API keys

After bundling, list the env vars each skill expects in `profile.yaml`:

```yaml
preflight:
  env_required:
    - LINEAR_API_KEY
    - TAVILY_API_KEY            # for tavily-research
    - OPENAI_API_KEY            # for image generation
    - WECHAT_APP_ID             # for baoyu-post-to-wechat
    - WECHAT_APP_SECRET
```

The launcher's `check` command verifies these are non-empty before starting.

---

## 6. Setting up CODEX_HOME

Each profile gets an isolated CODEX_HOME so different profiles don't share
sessions, history, or skill availability.

### Required structure

```
profiles/<name>/codex-home/
├── config.toml      → ~/.codex/config.toml      (symlink, share auth)
├── auth.json        → ~/.codex/auth.json        (symlink, gitignored)
└── skills/
    ├── .system      → ~/.codex/skills/.system   (symlink, system skills like imagegen)
    ├── linear       → ~/.codex/skills/linear    (symlink, ALWAYS include — agents need it)
    ├── ask-claude   → ~/.codex/skills/ask-claude (optional but useful)
    └── <profile-skills> → ../../skills/<name>   (relative symlink to bundled)
```

### One-shot setup script (run inside `profiles/<name>/`)

```bash
mkdir -p codex-home/skills
ln -sf ~/.codex/config.toml codex-home/config.toml
ln -sf ~/.codex/auth.json codex-home/auth.json
ln -sf ~/.codex/skills/.system codex-home/skills/.system

# Always include these codex-native skills
for s in linear ask-claude commit; do
  [ -d ~/.codex/skills/"$s" ] && ln -sf ~/.codex/skills/"$s" codex-home/skills/"$s"
done

# Bundle profile-specific skills
for d in skills/*/; do
  name=$(basename "$d")
  ln -sf "../../skills/$name" codex-home/skills/"$name"
done
```

The launcher exports `CODEX_HOME=<profile>/codex-home` before spawning, so all
Codex children read from this directory.

---

## 7. Linear setup

### Project + slug

1. Create a Linear project. Right-click → **Copy URL** to get the slug
   (last segment, e.g., `ziikoo-839b53546018`).
2. Put it in `profile.yaml.linear.project_slug` and `WORKFLOW.md.tracker.project_slug`.

### States — automated creation

In `profile.yaml`:

```yaml
linear:
  ensure_states:
    - {name: Researching, type: started, color: "#94a3b8"}
    - {name: Drafting,    type: started, color: "#5e6ad2"}
    - {name: Review,      type: started, color: "#f2c94c"}
    - {name: Publishing,  type: started, color: "#26b5ce"}
```

`type` is one of: `unstarted`, `started`, `completed`, `canceled`, `backlog`,
`triage`. Symphony itself doesn't care about `type` — only the **name** matches
your `active_states` / `terminal_states` lists.

> The launcher will auto-create missing states via Linear API on `start`.

### Labels — same pattern

```yaml
linear:
  ensure_labels:
    - {name: nda,       color: "#26b5ce"}
    - {name: framework, color: "#eb5757"}
    - {name: license,   color: "#f2994a"}
```

Labels route prompt branches in WORKFLOW.md (e.g., "if label `nda`, run NDA
review checklist; if label `framework`, run vendor framework review").

### Manual fallback

If you're not running the launcher's ensure logic yet, do it via Linear UI:
**Team Settings → Workflow** to add states, **labels** column to add labels.

---

## 8. Optional: SSH worker

Use this when **the publishing/output stage requires a fixed IP** (WeChat OA,
some bank APIs, IP-whitelisted SaaS):

### Setup

1. Provision a VPS (Ubuntu 22+ tested, $5-25/mo on RackNerd / Vultr / Aliyun).
2. Add the VPS public IP to the third-party API's IP whitelist.
3. SSH key auth from local Mac to VPS.
4. Bun + the publishing skill installed on VPS:
   ```bash
   ssh dev@<vps> 'curl -fsSL https://bun.sh/install | bash'
   rsync -av profiles/<name>/skills/<publish-skill>/ \
     dev@<vps>:~/.codex/skills/<publish-skill>/
   scp profiles/<name>/env dev@<vps>:~/.baoyu-skills/.env
   ```

### Profile preflight

```yaml
preflight:
  ssh_workers:
    - host: dev@74.48.189.45
      purpose: WeChat fixed-IP publishing
      check_cmd: 'test -x ~/.bun/bin/bun && test -f ~/.codex/skills/<publish-skill>/scripts/<entry>.ts'
```

### WORKFLOW.md publishing stage

Have the agent shell-out to the VPS for just the publish API call. See
`profiles/content-wechat/WORKFLOW.md` Stage 6 for a working example
(workspace rsync + path translation sed + ssh+bun publish + parse media_id).

---

## 9. Testing the new profile

### Smoke test path

```bash
# 1. preflight
./bin/symphony-launch check <name>

# 2. start
./bin/symphony-launch start <name>

# 3. create a TINY test issue in Linear (small word count, simple topic)
#    state: Todo / first active

# 4. watch dashboard
open http://127.0.0.1:<port>/

# 5. inspect agent's workspace
code ~/symphony-<your-domain>-workspaces/<ZII-N>/

# 6. when first PAUSE state hit, review and approve via Linear UI
```

### What to watch for during smoke

| Signal | What it tells you |
|---|---|
| state stays at first active for >2min, no comments | check logs for codex spawn errors |
| `linear_graphql` tool calls in logs | agent is using the tool ✓ |
| state advances through stages | state machine working ✓ |
| workspace files appear | hooks + agent producing artifacts ✓ |
| reaches first PAUSE | no human-required review gate is broken ✓ |

### Logs

```bash
tail -f profiles/<name>/runtime/log/symphony.log | grep -vE 'tick:.*active$'
```

Filter out tick noise to see real events.

---

## 10. Anti-patterns

### ❌ Hiding workflow logic in shell hooks
Keep the state-machine intent in `WORKFLOW.md`. Hooks are good for setup, archiving, and integration glue; they should not become an unreadable second orchestrator.

### ❌ Trusting user-generated fields in shell snippets
`{{ issue.title }}` and other tracker fields can contain spaces, quotes, or Unicode. Render them freely in prompt prose, but shell commands should quote variables carefully or fetch data at runtime through tools.

### ❌ Auto-publishing without a review gate
For any external system that has reputation/compliance/cost consequences
(WeChat OA, Twitter, public APIs), put a **PAUSE state** before the publish
action. Human-in-the-loop is the cheap insurance.

### ❌ Sharing one Linear project across profiles
Each profile = one project_slug. If two profiles share a project, both will
poll the same issues — race condition + double dispatch.

### ❌ Forgetting to gitignore the env file
`profiles/<name>/env` must be gitignored (the repo's root `.gitignore` already
covers `profiles/*/env`).

### ❌ Bundling huge skill node_modules
Skill `scripts/node_modules/` is gitignored at the repo level. If a skill
brings massive deps, factor out the heavy parts as separate VPS-side scripts.

### ❌ Treating dashboard tokens=0 as "agent stuck"
Some Codex builds don't emit `thread/tokenUsage/updated` notifications. Token
counter staying 0 doesn't mean agent isn't working. Check Linear state +
workspace files instead.

---

## 11. Three concrete sketches

### Sketch A · 自媒体内容生产 (already implemented in `content-wechat`)

```yaml
linear:
  states:
    active:    [Todo, Researching, Outlining, Drafting, Self-Editing, Rendering, Publishing]
    pause:     [Backlog, Draft Review, Final Review]
    terminal:  [Done, Cancelled]
  ensure_labels: [{name: 科普}, {name: 速报}, {name: 评论}, {name: 教程}]
preflight:
  skills_required: [tavily-research, last30days, mptext-api, ljg-writes,
                    baoyu-article-illustrator, baoyu-markdown-to-html,
                    baoyu-post-to-wechat, linear]
  ssh_workers: [{host: dev@<fixed-ip>, purpose: WeChat publishing}]
```

Use as reference: `profiles/content-wechat/`.

### Sketch B · 投资研究 (build from scratch)

State machine — Shape A with one analyst review gate:

```
Backlog → Todo → Gathering → Modeling → Writing → Analyst Review (PAUSE) → Approved → Done
```

```yaml
linear:
  ensure_states:
    - {name: Gathering,        type: started, color: "#94a3b8"}
    - {name: Modeling,         type: started, color: "#7dd3fc"}
    - {name: Writing,          type: started, color: "#5e6ad2"}
    - {name: "Analyst Review", type: started, color: "#f2c94c"}
    - {name: Approved,         type: started, color: "#26b5ce"}
  ensure_labels:
    - {name: deep-dive}        # full research note
    - {name: quarter-update}   # incremental update
    - {name: thesis-check}     # verification of an existing thesis
preflight:
  env_required: [LINEAR_API_KEY, TAVILY_API_KEY, TUSHARE_TOKEN]
  skills_required: [tavily-research, firecrawl-scrape, web-access, tushare,
                    market-research, linear]
```

Prompt body (skeleton):

```markdown
### state == "Gathering"
1. Fetch issue spec via linear_graphql (target ticker / company / topic).
2. Use tushare to pull last 4 quarters of financials → research/financials.csv
3. Use tavily-research for market context → research/context.md
4. Use firecrawl-scrape to grab investor-relations page → research/ir.md
5. Set state to Modeling.

### state == "Modeling"
1. Build DCF / comparable model in research/model.md
2. Identify 3 base/bull/bear scenarios with explicit assumptions cited.
3. Set state to Writing.

### state == "Writing"
1. Produce 1500-3000 word research note based on outline.md and research/
2. Every claim with a number must cite a source_id from research/.
3. Set state to Analyst Review.
```

### Sketch C · 合同审查 (build from scratch)

State machine — Shape A with explicit "Lawyer Review" PAUSE:

```
Backlog → Intake → Risk Analysis → Lawyer Review (PAUSE) → Cleared → Signed → Done
                                                       ↓
                                               Negotiation → Risk Analysis (loop)
```

```yaml
linear:
  ensure_states:
    - {name: Intake,          type: unstarted, color: "#94a3b8"}
    - {name: "Risk Analysis", type: started,   color: "#7dd3fc"}
    - {name: "Lawyer Review", type: started,   color: "#f2c94c"}  # PAUSE
    - {name: Negotiation,     type: started,   color: "#fbbf24"}
    - {name: Cleared,         type: started,   color: "#26b5ce"}
    - {name: Signed,          type: completed, color: "#22c55e"}
  ensure_labels:
    - {name: NDA}
    - {name: framework-agreement}
    - {name: license-grant}
    - {name: dpa}              # data processing addendum
preflight:
  env_required: [LINEAR_API_KEY]
  skills_required: [pdf, docx, firecrawl-scrape, web-access, linear]
```

Prompt body:

```markdown
### state == "Intake"
1. Fetch issue via linear_graphql; expect attached PDF/docx of contract.
2. Use pdf or docx skill to extract → input/contract.txt
3. Identify counterparty + governing law + term length → input/meta.json
4. Set state to Risk Analysis.

### state == "Risk Analysis"
1. Apply company's standard checklist (read references/checklist.md).
2. For each clause class (NDA / liability / IP / data) flag risk level →
   risk-report.md
3. Cite exact contract section/page for each finding.
4. Set state to Lawyer Review.

### state == "Negotiation" (after lawyer flags issues)
1. Read latest comment for lawyer's redline list.
2. Draft proposed redlines → output/redline-proposal.md
3. Set state to Lawyer Review.
```

---

## Appendix: profile.yaml field reference (quick scan)

```yaml
name: <unique-id>                # required, dash-separated
schema_version: 1                # required, increment on breaking schema change
version: <semver>                # this profile's version
description: <one-line>          # shown in `symphony-launch list`
maintainer: <email>

symphony:
  port: <int>                    # must be unique across active profiles
  bypass_guardrails: true        # adds the guardrails-bypass CLI flag
  workspace_root: <path>         # ~ + $VAR expanded
  archive_root:   <path>

linear:
  team_id: <uuid>
  project_slug: <slug>
  states:
    active: [...]
    pause:  [...]
    terminal: [...]
  ensure_states:                 # launcher creates missing on start
    - {name: ..., type: ..., color: ...}
  ensure_labels:
    - {name: ..., color: ...}

preflight:
  env_required: [...]            # env vars that must be non-empty
  skills_required: [...]         # subdirs of profiles/<name>/skills/
  ssh_workers:
    - host: user@host
      purpose: <description>
      check_cmd: <bash command>

notes: |
  Free-form maintainer notes (not parsed)
```

For full schema, see [profile-spec.md](profile-spec.md).
