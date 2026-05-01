# _template

Skeleton for creating a new profile.

## Steps

```bash
# 1. Copy this template to a new profile dir
cp -r profiles/_template profiles/<my-pipeline>
cd profiles/<my-pipeline>

# 2. Rename the templates to active files
mv profile.yaml.template profile.yaml
mv WORKFLOW.md.template WORKFLOW.md

# 3. Edit metadata + Linear config
$EDITOR profile.yaml          # name, port (must be unique), workspace_root, linear.*

# 4. Edit pipeline definition
$EDITOR WORKFLOW.md           # state machine + prompt body

# 5. Wire credentials
cp env.example env
$EDITOR env

# 6. Add profile-specific skills (optional)
#    Copy from ~/.codex/skills/ or ~/.claude/skills/ as needed
cp -r ~/.codex/skills/<some-skill> skills/

# 7. Build codex-home symlink farm
mkdir -p codex-home/skills
ln -sf ~/.codex/config.toml codex-home/config.toml
ln -sf ~/.codex/auth.json codex-home/auth.json
ln -sf ~/.codex/skills/.system codex-home/skills/.system
for d in skills/*/; do
  name=$(basename "$d")
  ln -sf "../../skills/$name" "codex-home/skills/$name"
done

# 8. Validate
cd ../..
./bin/symphony-launch check <my-pipeline>

# 9. Run
./bin/symphony-launch start <my-pipeline>
```

## Files in this template

| File | Purpose |
|---|---|
| `profile.yaml.template` | Profile metadata stub — rename to `profile.yaml` |
| `WORKFLOW.md.template`  | Symphony pipeline stub — rename to `WORKFLOW.md` |
| `env.example`           | Credentials template — copy to `env` and fill in |
| `README.md`             | This file (delete or replace in your profile) |
| `skills/`               | Empty; put profile-specific skills here |
| `codex-home/`           | Empty; build symlink farm during setup (step 7) |
| `runtime/`              | Empty; auto-populated by launcher |
