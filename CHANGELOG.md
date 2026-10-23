# Changelog

## 0.2.0

Pi Web support and a repository picker.

### Added

- **Repository picker.** A directory that holds several repositories (sibling checkouts, or a
  monorepo with nested ones) now asks which one to show. Discovery looks at the session directory
  and up to three levels below it, skips `node_modules`/`dist`/`build`/`.venv` and similar, and
  lists the session's own repository first.
- **`n` / `p` (and `←` / `→`) switch repository** inside the open panel, so comparing two
  checkouts does not mean closing and reopening it.
- **`/git-graph repos`** lists the repositories found, without opening a dialog.
- **`/git-graph <path>`** narrows the panel to one repository.
- The panel shows the repository name, its position in the list (`web 2/2`), and the full path.

### Changed

- **Pi Web compatibility.** Outside the TUI the panel asks for a fixed column width (Pi Web reads
  `overlayOptions.width` only when it is a number) and does not request a terminal overlay.
- The commit window fills the host's terminal rows, bounded to 48, instead of a hard-coded 28, so a
  tall dialog is not left half empty. The TUI overlay keeps its previous behaviour.
- An initialised repository with no commits shows "No commits yet." instead of git's `fatal:` line.
- `session_start` no longer assumes a TUI-only status line.

### Fixed

- `.git` as a file (linked worktrees, submodules) is recognised as a repository root.
