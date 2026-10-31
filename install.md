# Install mods

Runbook for installing Claude Code mods from `~/.claude/mods/`. Written so an agent or a person can follow it cold.

## How mods load

- Each mod is a folder with `.claude-plugin/plugin.json`.
- Mods load through the colon-separated `CLAUDE_CODE_PLUGIN_DIRS` value in `~/.claude/settings.json` under `env`.
- Restart Claude Code after changing the list. New sessions pick up the list; open sessions do not.

## Current mods

| Mod | Path | Purpose |
| --- | --- | --- |
| evolve | `~/.claude/mods/evolve` | Agent memory: Jev gates turns, Haiku writes notes, `/evolve` dashboard |
| jev-router | `~/.claude/mods/jev-router` | Jev picks the model tier per turn and subagent, `/jev` dashboard |
| yt | `~/.claude/mods/yt` | YouTube mod |
| claude-auto-handoff | `~/.claude/mods/claude-auto-handoff` | Hands off to a fresh session near the context limit |

Each mod with a README has its own setup notes. Read it first.

## 1. Clone a mod

```bash
git clone https://github.com/NOOB-3301/claude-code-evolve.git ~/.claude/mods/evolve
```

Use the repo URL for the mod. Keep the folder name the same as the mod's `plugin.json` name where possible.

## 2. Register the mod

Add the path to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`. Append with a colon, no spaces, no trailing colon:

```bash
python3 - <<'PY'
import json, pathlib
p = pathlib.Path.home() / ".claude/settings.json"
s = json.loads(p.read_text())
dirs = [d for d in s["env"]["CLAUDE_CODE_PLUGIN_DIRS"].split(":") if d]
mod = str(pathlib.Path.home() / ".claude/mods/evolve")
if mod not in dirs:
    dirs.append(mod)
s["env"]["CLAUDE_CODE_PLUGIN_DIRS"] = ":".join(dirs)
p.write_text(json.dumps(s, indent=2) + "\n")
print(s["env"]["CLAUDE_CODE_PLUGIN_DIRS"])
PY
```

Check the result shows the mod path once. Duplicates are harmless but untidy.

## 3. Provide the API key

Evolve and jev-router use TypeSafe. Use either:

- `export TYPESAFE_API_KEY=...` in the shell environment, or
- `typesafeApiKey` in jev-router's config at `~/.claude/jev-router/config.json`.

Never commit a key. Never paste one into a mod's source.

## 4. Restart and verify

1. Quit and restart Claude Code.
2. Run `/evolve` (dashboard opens) and `/evolve status` if it exists.
3. Confirm evolve is on. Its config is `~/.claude/evolve/config.json`. Turn it on with `/evolve on`.

## 5. Validate and test a mod

From the mod folder:

```bash
claude plugin validate .
claude plugin test .
```

Both must pass before pushing.

## Updating a mod

```bash
cd ~/.claude/mods/evolve && git pull
```

Then restart Claude Code.

## Editing a mod

- Edit the persistent copy in `~/.claude/mods/<name>`.
- Do not edit `~/.claude/dev-mods/<uuid>/`. Those are session-only copies.
- Commit and push from the mod folder.

## Known gotchas

- `CLAUDE_CODE_PLUGIN_DIRS` may still point at `~/.claude/dev-mods/<uuid>/statusdeck`. That copy is session-only. Point it at a persistent mod folder if one exists, or remove the entry.
- The evolve database `~/.claude/evolve/evolve.db` is shared by all sessions. Test notes written there persist.
- The validator rejects `update` calls in `register.tsx` made through a helper. Name each atom directly.
- `.claude-plugin/types/` is git-ignored (its own `.gitignore` is `*`). It holds generated type stubs that `tsconfig.json` extends. A fresh clone lacks it, so tsc can't resolve until the plugin tooling regenerates it. Run `claude plugin validate .` first.
