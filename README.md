# pi-git-graph-sidebar

A VS Code Git Graph-style sidebar overlay for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) TUI.

It opens an interactive right-side graph of your repository history using `git log --graph --decorate --oneline --all`.

## Features

- Right-side responsive TUI overlay/sidebar
- ASCII commit graph across all refs
- Branch/decorator display from Git
- Keyboard navigation
- Refresh without closing the sidebar
- Works as a Pi package installed from npm or GitHub

## Preview

```text
╭──────────────── Git Graph ────────────────╮
│branch main • 120/120                      │
│cwd /path/to/repo                          │
├───────────────────────────────────────────┤
│› * a1b2c3d (HEAD -> main, origin/main) ...│
│  * d4e5f6a Add feature                    │
│  | * 123abcd (feature/x) Try variant      │
│  |/                                      │
│  * 987fedc Initial commit                 │
├───────────────────────────────────────────┤
│↑↓/jk scroll • r refresh • q/esc close     │
╰───────────────────────────────────────────╯
```

## Installation

### From npm

```bash
pi install npm:pi-git-graph-sidebar
```

Then restart Pi or run `/reload` in an existing Pi TUI session.

### From GitHub

```bash
pi install git:github.com/yuxiang-gao/pi-git-graph-sidebar
```

### Try without installing

```bash
pi -e npm:pi-git-graph-sidebar
# or
pi -e git:github.com/yuxiang-gao/pi-git-graph-sidebar
```

### Manual local install

```bash
mkdir -p ~/.pi/agent/extensions
curl -L \
  https://raw.githubusercontent.com/yuxiang-gao/pi-git-graph-sidebar/main/extensions/git-graph-sidebar.ts \
  -o ~/.pi/agent/extensions/git-graph-sidebar.ts
```

Restart Pi or run `/reload`.

## Usage

Open the sidebar:

```text
/git-graph
```

Open with a custom commit limit:

```text
/git-graph 200
```

Keyboard shortcut:

```text
ctrl+shift+g
```

Keyboard controls inside the sidebar:

| Key | Action |
| --- | --- |
| `↑` / `k` | Move up |
| `↓` / `j` | Move down |
| `PgUp` / `ctrl+u` | Page up |
| `PgDn` / `ctrl+d` | Page down |
| `g` | Jump to top |
| `G` | Jump to bottom |
| `r` | Refresh graph |
| `q` / `esc` | Close sidebar |

## Notes

- Requires `git` on `PATH`.
- The sidebar is visible only when the terminal is at least 90 columns wide.
- The default commit limit is 120; the maximum accepted limit is 500.
- Pi packages run extension code with local system access. Review code before installing third-party packages.

## Development

Clone and run Pi with the local package:

```bash
git clone https://github.com/yuxiang-gao/pi-git-graph-sidebar.git
cd pi-git-graph-sidebar
pi -e .
```

Or install the local checkout globally:

```bash
pi install /absolute/path/to/pi-git-graph-sidebar
```

## License

MIT
