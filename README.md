# claude-code-evolve

Agent memory that evolves for [Claude Code](https://claude.com/claude-code).

Each turn, a small model (TypeSafe Jev) decides whether the turn holds anything worth remembering. If it does, Haiku writes versioned notes into a local SQLite database. Before later prompts, the notes Jev judges relevant are injected back into context. Notes are typed (for example `project_convention`, `feedback`, `user_preference`), and Haiku can propose new types when existing ones don't fit.

Everything is local except the two model calls, and the database is shared across sessions.

## Features

- **Turn gate**: Jev answers a yes/no `worth` question per turn. Below the threshold (0.5), Haiku never runs.
- **Typed notes**: Haiku returns JSON with `new_types` and `edits`. Types are lowercase snake_case, 2-40 characters, with a description. A new type must come with at least one note.
- **Versioned storage**: SQLite at `~/.claude/evolve/evolve.db`, shared by every session.
- **Injection**: relevant notes are added to later prompts inside an `<evolved-memory>` block.
- **Secret scrubbing**: turn text is capped at 12,000 characters and scrubbed before it leaves the machine.
- **Dashboard**: `/evolve` opens a terminal pane with stat tiles, charts, per-type memory bars and an activity log.
- **Toggle**: `/evolve on` and `/evolve off` (saved in `~/.claude/evolve/config.json`).

## Requirements

- Claude Code with plugin directory support (`CLAUDE_CODE_PLUGIN_DIRS`)
- A TypeSafe API key, set as `TYPESAFE_API_KEY` or in jev-router's config
- Bun or Node for the TypeScript hooks

## Install

```
/plugin install evolve --marketplace NOOB-3301/claude-code-evolve
```

Needs Claude Code 2.1.275 or later. For a manual install from a local clone, see [install.md](install.md).

## Usage

| Command | Effect |
| --- | --- |
| `/evolve` | Open the dashboard pane |
| `/evolve on` / `/evolve off` | Resume or pause note creation and injection |

## Layout

```
hooks/
  lib.ts         turn gate, Jev/Haiku calls, parsing, injection
  db.ts          SQLite schema and queries
  charts.ts      terminal charts (stretch() spans short series)
  dashboard.tsx  pane UI
  register.tsx   command, hook and state wiring
  hooks.json     hook registration
tests/           lib and pane tests
types/           plugin type declarations
```

## Development

```
claude plugin validate .
claude plugin test .
```

Edit the copy under `~/.claude/mods/evolve`, not a session copy under `dev-mods/`.

## Status

Early (0.1.0). Known gaps:

- The dashboard has been checked with sample data in a test render, not yet in a live terminal session.
- `update` calls in `register.tsx` must name each atom directly. The validator rejects them through a helper.

## License

No license file yet. All rights reserved until one is added.
