# opencode-skilld

An [OpenCode](https://opencode.ai) plugin that keeps skills from GitHub repositories up to date, in the background.

`gh skill install --all` takes upwards of a minute, and OpenCode loads plugins before it scans for skills — so refreshing on the critical path would put that minute on every single launch. Skilld fires the refresh off unawaited and lets the next launch pick up whatever landed, with a pair of toasts so a first run does not just sit there looking broken.

## Requirements

- [`gh`](https://cli.github.com) on `PATH`, logged in, recent enough to have `gh skill` — which is itself in preview and "subject to change without notice", so an older `gh` will not have it at all.

A missing or unauthenticated `gh` is not fatal: you get an error toast and whatever skills you already had.

## Install

Name it in `opencode.jsonc`, together with the repositories you want. opencode resolves plugins from npm, so there is nothing to install by hand:

```jsonc
{
	"plugin": [
		["opencode-skilld", { "sources": ["anthropics/skills"] }]
	],
	"skills": {
		"paths": ["{env:HOME}/.local/share/opencode/skills/anthropics-skills"]
	}
}
```

The `skills.paths` entry is what actually makes OpenCode load them — the plugin only downloads. Unlike a `{file:}` reference, a path that does not exist yet is silently skipped rather than fatal, which is exactly what a machine that has never refreshed needs.

With no `sources`, the plugin does nothing at all.

> [!WARNING]
> Running from a local checkout instead of npm? Keep the file **out of `~/.config/opencode/plugin/`**. Everything in that directory is auto-loaded before the config is read and handed no options, and an explicit `plugin` entry pointing at it is deduped away — so `sources` never arrives and the plugin silently does nothing. Park it anywhere else (say, `~/.config/opencode/lib/`) and reference that path.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `sources` | `[]` | Repositories to refresh from. A plain `"owner/repo"` string, or an object (below). |
| `interval` | `86400000` (24 h) | How long a refresh stays fresh, in milliseconds. |

A source given as an object can override what the string form derives:

| Field | Default | Meaning |
| --- | --- | --- |
| `repo` | — | The GitHub `"owner/repo"` to install from. Required. |
| `target` | `~/.local/share/opencode/skills/<slug>` | Where to install. `<slug>` is `repo` with `/` turned into `-`. |
| `stamp` | `~/.local/state/opencode/<slug>-refreshed` | Where the last successful refresh is recorded. |
| `label` | `repo` | The name used in toasts. |
| `placeholder` | `"template"` | A placeholder skill directory to delete after installing, or `false` to keep whatever upstream ships. |

Defaults land outside any config repository on purpose, so a refresh never shows up as `git status` noise.

A leading `~` in `target` or `stamp` is expanded. Nothing else is: these go to `mkdirSync`, not to a shell.

Options are read from a hand-written file, so none of the types above are enforced at runtime. Anything that does not match is ignored with an error toast rather than taken literally — an option with an unknown name, a `sources` that is not an array, an entry that names no `repo` or gives a field the wrong type, an `interval` that is not a number.

```jsonc
{
	"plugin": [
		[
			"opencode-skilld",
			{
				"interval": 604800000,
				"sources": [
					"anthropics/skills",
					{
						"repo": "someone/their-skills",
						"target": "~/skills/theirs",
						"label": "their skills",
						"placeholder": false
					}
				]
			}
		]
	]
}
```

### About `placeholder`

Repositories started from GitHub's skill template tend to ship a `template/` skill described as *"Replace with description of the skill and when Claude should use it."* It has a description, so OpenCode will not filter it out, and a trigger that vague fires on almost anything. Skilld deletes it by default. Point `placeholder` at a different directory name if a repository names its placeholder something else, or set it to `false` to keep everything.

It has to be a single directory name. A `""`, a `"."`, a `".."` or anything with a separator in it is refused and nothing is deleted — the deletion is recursive and forced, so an empty string would otherwise aim it at `target` itself.

## Behaviour

- Refreshes at most once per `interval` per source, tracked by a stamp file that is written **after** a refresh succeeds — so an interrupted one simply retries next launch.
- Never awaited, and the child process is unreferenced, so quitting OpenCode never waits on a download.
- Nothing throws. A missing `gh`, an expired login, a plane — all of them degrade to an error toast.
- Toasts are best-effort: under `opencode run` there is no TUI listening, and that is not an error.
- Every toast is held back a few seconds, because plugins load before the TUI starts listening and a toast fired into that gap is simply lost — which is exactly when a missing `gh` fails. A refresh that finishes inside that window cancels the "in the background" message rather than following it.

Because the refresh outlives the launch that started it, a download still running when you quit finishes but records nothing, costing one redundant download next time.

## Development

```bash
bun install
bun test
bun run typecheck
```

There is no build step — OpenCode loads the TypeScript directly.
