# pi-git-graph-sidebar

A VS Code Git Graph-style commit graph for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) — in the Pi TUI and in [Pi Web](https://github.com/agegr/pi-web).

It draws your repository history with `git log --graph --decorate --oneline --all`, and when a directory holds several repositories it lets you pick one and switch between them without closing the panel.

## Features

- Commit graph across all refs, with branch and tag decorations
- Right-side overlay in the TUI, a dialog panel in Pi Web
- **Repository picker** for a directory that holds several repositories (a workspace of sibling checkouts, or a monorepo with nested ones)
- `n` / `p` switches repository inside the panel
- Keyboard navigation and refresh without closing
- Works as a Pi package installed from npm, GitHub, or a local checkout

## Preview

```text
╭──────────────── Git Graph ────────────────╮
│repo web 2/2 • branch main • 2/120         │
│/work/web                                  │
├───────────────────────────────────────────┤
│› * a1b2c3d (HEAD -> main, origin/main) ...│
│  * d4e5f6a Add feature                    │
│  | * 123abcd (feature/x) Try variant      │
│  |/                                       │
│  * 987fedc Initial commit                 │
├───────────────────────────────────────────┤
│↑↓/jk scroll • n/p repo • r refresh • q/esc│
╰───────────────────────────────────────────╯
```

## Installation

### From npm

```bash
pi install npm:pi-git-graph-sidebar
```

Then restart Pi or run `/reload` in an existing session.

### From GitHub

```bash
pi install git:github.com/gaoxingxs/pi-git-graph-sidebar
```

### Try without installing

```bash
pi -e npm:pi-git-graph-sidebar
# or
pi -e git:github.com/gaoxingxs/pi-git-graph-sidebar
```

### Manual local install

```bash
mkdir -p ~/.pi/agent/extensions
curl -L \
  https://raw.githubusercontent.com/gaoxingxs/pi-git-graph-sidebar/main/extensions/git-graph-sidebar.ts \
  -o ~/.pi/agent/extensions/git-graph-sidebar.ts
```

Restart Pi or run `/reload`.

## Usage

```text
/git-graph              # current directory; asks which repository when there are several
/git-graph 200          # with a commit limit
/git-graph repos        # list the repositories found, without opening the panel
/git-graph packages/api # narrow to one repository (and the repositories below it)
```

Keyboard shortcut: `ctrl+shift+g` (TUI).

### Several repositories in one directory

Starting a session in `~/code`, or in a monorepo that holds nested checkouts, gives more than one repository. Then:

- `/git-graph` asks which one, and the panel remembers the choice for that open panel
- `n` / `p` (or `←` / `→`) switch repository inside the panel, without reopening it
- `/git-graph repos` prints what was found, so you can see the list without a dialog
- `/git-graph <path>` skips the question and shows that repository

Discovery looks at the session directory and up to three levels below it, skipping `node_modules`, `dist`, `build`, `.venv`, and similar directories. The session directory's own repository is listed first. A repository that is not the session's own is not descended into, so a nested checkout inside a dependency is never picked up.

### Keyboard controls

| Key | Action |
| --- | --- |
| `↑` / `k` | Move up |
| `↓` / `j` | Move down |
| `PgUp` / `ctrl+u` | Page up |
| `PgDn` / `ctrl+d` | Page down |
| `g` / `Home` | Jump to top |
| `G` / `End` | Jump to bottom |
| `n` / `→` | Next repository |
| `p` / `←` | Previous repository |
| `r` | Refresh |
| `q` / `esc` | Close |

## Pi Web

Pi Web runs sessions in RPC mode and mounts an extension's custom UI in a browser dialog. The panel adapts to that host:

- **Fixed column width instead of a percentage.** Pi Web reads `overlayOptions.width` only when it is a number; the TUI keeps `"42%"` and the right-center anchor.
- **No fixed row count.** The commit window fills the host's terminal rows (bounded to 48) instead of the original hard-coded 28, so a tall dialog is not left half empty.
- **`/git-graph` command only.** `ctrl+shift+g` is a TUI keybinding; the browser does not forward it.
- **The panel is a dialog, not an overlay.** It does not float over the transcript; Pi Web shows it above the chat with its own close button.

Everything else — repository discovery, the picker, `n`/`p` switching, refresh, scrolling — behaves the same in both hosts.

## Notes

- Requires `git` on `PATH`.
- In the TUI the overlay appears only when the terminal is at least 90 columns wide.
- The default commit limit is 120; the maximum accepted is 500.
- A repository with no commits shows "No commits yet." rather than a `fatal:` line.
- Pi packages run extension code with local system access. Review code before installing third-party packages.

## Development

```bash
git clone https://github.com/gaoxingxs/pi-git-graph-sidebar.git
cd pi-git-graph-sidebar
pi -e .            # run Pi with this checkout
npm test           # node --test, no build step
npm run typecheck  # needs the pi packages linked into node_modules
```

Layout:

```
extensions/git-graph-sidebar.ts   the extension: discovery, git calls, panel
tests/discovery.test.ts           repository discovery and argument parsing
tests/extension.test.ts           registration, rendering, input, pi-web options
```

## Credits

Forked from [yuxiang-gao/pi-git-graph-sidebar](https://github.com/yuxiang-gao/pi-git-graph-sidebar). This fork adds Pi Web compatibility and the multi-repository picker.

## License

MIT
