import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { readdirSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

function visibleWidth(text: string): number {
	return Array.from(text.replace(ANSI_PATTERN, "")).length;
}

function truncateToWidth(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	const plain = text.replace(ANSI_PATTERN, "");
	const suffix = visibleWidth(ellipsis) < width ? ellipsis : "";
	return `${Array.from(plain).slice(0, Math.max(0, width - visibleWidth(suffix))).join("")}${suffix}`;
}

function isKey(data: string, key: string): boolean {
	const aliases: Record<string, string[]> = {
		escape: ["\x1b"],
		up: ["\x1b[A", "\x1bOA"],
		down: ["\x1b[B", "\x1bOB"],
		left: ["\x1b[D", "\x1bOD"],
		right: ["\x1b[C", "\x1bOC"],
		pageUp: ["\x1b[5~"],
		pageDown: ["\x1b[6~"],
		home: ["\x1b[H", "\x1bOH", "\x1b[1~"],
		end: ["\x1b[F", "\x1bOF", "\x1b[4~"],
		ctrlC: ["\x03"],
		ctrlD: ["\x04"],
		ctrlU: ["\x15"],
	};
	return aliases[key]?.includes(data) ?? data === key;
}

/** One repository the graph can show. */
export type GitRepo = {
	/** Absolute path of the repository root (the directory holding `.git`). */
	root: string;
	/** Display name: the root's directory name. */
	name: string;
};

export type GitGraphData = {
	repo: GitRepo;
	branch: string;
	lines: string[];
	error?: string;
	loadedAt: Date;
};

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 500;
/** How deep to look for repositories below the session directory. */
const DISCOVERY_DEPTH = 3;
const DISCOVERY_MAX_REPOS = 64;

/**
 * Directories never worth descending into while looking for repositories: build output, caches,
 * virtualenvs, and dependency trees. `.git` itself is handled by the repository check.
 */
const SKIP_DIRECTORIES = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	".jj",
	"dist",
	"build",
	"out",
	"target",
	"vendor",
	".venv",
	"venv",
	"env",
	"__pycache__",
	".next",
	".nuxt",
	".turbo",
	".cache",
	"coverage",
	".gradle",
	".idea",
	".vscode",
	"Pods",
	"DerivedData",
]);

function parseLimit(args: string): number {
	const trimmed = args.trim();
	if (!trimmed) return DEFAULT_LIMIT;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
	return Math.min(parsed, MAX_LIMIT);
}

function samePath(left: string, right: string): boolean {
	return resolve(left) === resolve(right);
}

/** Whether `dir` holds a `.git` entry (a directory, or a file for worktrees and submodules). */
function isRepositoryRoot(dir: string): boolean {
	try {
		const stats = statSync(join(dir, ".git"));
		return stats.isDirectory() || stats.isFile();
	} catch {
		return false;
	}
}

function compareRepos(left: GitRepo, right: GitRepo): number {
	return left.name.localeCompare(right.name) || left.root.localeCompare(right.root);
}

/**
 * Repositories visible from a directory.
 *
 * A session usually starts either inside a repository or in a folder that holds several of them
 * (`~/code`, a workspace of sibling checkouts). Both are covered: the session directory's own
 * repository comes first, then every repository found below it, breadth-first and bounded so a
 * large tree cannot stall the panel. A repository found during the scan is not descended into —
 * except the session directory's own repository, whose nested checkouts are still wanted.
 */
export function discoverRepositories(cwd: string, ownRepoRoot?: string): GitRepo[] {
	const start = resolve(cwd);
	const found: GitRepo[] = [];
	const seen = new Set<string>();

	const add = (root: string): void => {
		const absolute = resolve(root);
		if (seen.has(absolute)) return;
		seen.add(absolute);
		found.push({ root: absolute, name: basename(absolute) || absolute });
	};

	if (ownRepoRoot) add(ownRepoRoot);

	const scan = (dir: string, depth: number): void => {
		if (found.length >= DISCOVERY_MAX_REPOS) return;
		const isRepo = isRepositoryRoot(dir);
		if (isRepo) add(dir);
		if (depth >= DISCOVERY_DEPTH) return;
		// Descending into a nested repository would walk its whole tree; the one exception is the
		// session directory's own repository, whose nested checkouts are exactly what we are after.
		if (isRepo && !(ownRepoRoot && samePath(dir, ownRepoRoot)) && !samePath(dir, start)) return;

		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (found.length >= DISCOVERY_MAX_REPOS) return;
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			if (SKIP_DIRECTORIES.has(entry.name)) continue;
			if (entry.name.startsWith(".") && entry.name !== ".") continue;
			scan(join(dir, entry.name), depth + 1);
		}
	};

	scan(start, 0);

	// The session directory's own repository is the most likely target, so it leads the list.
	if (ownRepoRoot) {
		const own = resolve(ownRepoRoot);
		const rest = found.filter((repo) => !samePath(repo.root, own)).sort(compareRepos);
		const primary = found.find((repo) => samePath(repo.root, own));
		return primary ? [primary, ...rest] : rest;
	}
	return found.sort(compareRepos);
}

/** The repository root containing `dir`, via git itself, or undefined outside any repository. */
async function repositoryRootOf(pi: ExtensionAPI, dir: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 3000 });
	if (result.code !== 0) return undefined;
	const root = result.stdout.trim();
	return root.length > 0 ? root : undefined;
}

async function loadGitGraph(pi: ExtensionAPI, repo: GitRepo, limit: number): Promise<GitGraphData> {
	const common = { repo, loadedAt: new Date() };

	const branchResult = await pi.exec("git", ["branch", "--show-current"], {
		cwd: repo.root,
		timeout: 3000,
	});
	const branch = branchResult.stdout.trim() || "detached";

	const log = await pi.exec(
		"git",
		[
			"log",
			"--graph",
			"--decorate=short",
			"--oneline",
			"--abbrev-commit",
			"--date-order",
			"--all",
			`-n${limit}`,
		],
		{ cwd: repo.root, timeout: 8000 },
	);

	if (log.code !== 0) {
		const stderr = log.stderr.trim();
		// An initialised repository without commits is not an error worth shouting about.
		const empty = /does not have any commits yet|your current branch .* does not have any commits/i.test(stderr);
		return {
			...common,
			branch,
			lines: [],
			error: empty ? "No commits yet." : stderr || "git log failed.",
		};
	}

	return {
		...common,
		branch,
		lines: log.stdout.split("\n").filter((line) => line.trim().length > 0),
	};
}

/** Terminal rows the panel may fill. pi-web mounts the component in a scrollable dialog. */
function rowBudget(tui: TUI, compact: boolean): number {
	const rows = tui.terminal?.rows;
	if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0) return 28;
	// A TUI overlay floats over the transcript and must leave the editor visible; a pi-web panel
	// owns the whole dialog, so only the dialog chrome is deducted.
	const reserved = compact ? 2 : 8;
	return Math.max(12, Math.min(48, rows - reserved));
}

class GitGraphSidebar implements Component {
	private offset = 0;
	private selected = 0;
	private loading = false;
	private message: string | undefined;
	private readonly pi: ExtensionAPI;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly cwd: string;
	private readonly limit: number;
	private readonly compact: boolean;
	private readonly done: () => void;
	private repos: GitRepo[];
	private index: number;
	private data: GitGraphData;

	constructor(options: {
		pi: ExtensionAPI;
		tui: TUI;
		theme: Theme;
		cwd: string;
		limit: number;
		repos: GitRepo[];
		index: number;
		data: GitGraphData;
		compact: boolean;
		done: () => void;
	}) {
		this.pi = options.pi;
		this.tui = options.tui;
		this.theme = options.theme;
		this.cwd = options.cwd;
		this.limit = options.limit;
		this.repos = options.repos;
		this.index = options.index;
		this.data = options.data;
		this.compact = options.compact;
		this.done = options.done;
	}

	handleInput(data: string): void {
		if (isKey(data, "escape") || isKey(data, "q") || isKey(data, "ctrlC")) {
			this.done();
			return;
		}
		// Repository switching: `n`/`p` and the horizontal arrows, so a directory holding several
		// repositories can be browsed without closing the panel.
		if (isKey(data, "n") || isKey(data, "right")) {
			void this.switchRepository(1);
			return;
		}
		if (isKey(data, "p") || isKey(data, "left")) {
			void this.switchRepository(-1);
			return;
		}
		if (isKey(data, "up") || isKey(data, "k")) {
			this.selected = Math.max(0, this.selected - 1);
			this.ensureSelectedVisible();
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "down") || isKey(data, "j")) {
			this.selected = Math.min(Math.max(0, this.data.lines.length - 1), this.selected + 1);
			this.ensureSelectedVisible();
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "pageUp") || isKey(data, "ctrlU")) {
			this.selected = Math.max(0, this.selected - 10);
			this.ensureSelectedVisible();
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "pageDown") || isKey(data, "ctrlD")) {
			this.selected = Math.min(Math.max(0, this.data.lines.length - 1), this.selected + 10);
			this.ensureSelectedVisible();
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "home") || isKey(data, "g")) {
			this.selected = 0;
			this.offset = 0;
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "end") || isKey(data, "G")) {
			this.selected = Math.max(0, this.data.lines.length - 1);
			this.ensureSelectedVisible();
			this.tui.requestRender();
			return;
		}
		if (isKey(data, "r")) {
			void this.refresh();
		}
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const border = (text: string) => this.theme.fg("border", text);
		const pad = (text: string) => {
			const truncated = truncateToWidth(text, innerWidth, "…");
			return `${truncated}${" ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)))}`;
		};
		const row = (text: string) => `${border("│")}${pad(text)}${border("│")}`;
		const lines: string[] = [];

		const title = this.theme.fg("accent", this.theme.bold(" Git Graph "));
		const titleWidth = visibleWidth(" Git Graph ");
		const left = "─".repeat(Math.max(0, Math.floor((innerWidth - titleWidth) / 2)));
		const right = "─".repeat(Math.max(0, innerWidth - titleWidth - left.length));
		lines.push(`${border("╭" + left)}${title}${border(right + "╮")}`);

		const repoLabel = this.repos.length > 1
			? `${this.data.repo.name} ${this.index + 1}/${this.repos.length}`
			: this.data.repo.name;
		lines.push(
			row(
				`${this.theme.fg("dim", "repo")} ${this.theme.fg("accent", repoLabel)} ${this.theme.fg("dim", "• branch")} ${this.theme.fg("success", this.data.branch || "-")} ${this.theme.fg("dim", `• ${this.data.lines.length}/${this.limit}`)}`,
			),
		);
		lines.push(row(this.theme.fg("dim", this.data.repo.root)));
		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));

		if (this.loading) {
			lines.push(row(`${this.theme.fg("accent", "⟳")} loading…`));
		}
		if (this.message) {
			lines.push(row(this.theme.fg("warning", this.message)));
		}
		if (this.data.error) {
			lines.push(row(this.theme.fg("error", this.data.error)));
		} else if (this.data.lines.length === 0) {
			lines.push(row(this.theme.fg("muted", "No commits found.")));
		} else {
			const headerLines = lines.length;
			const footerLines = 3;
			const budget = rowBudget(this.tui, this.compact);
			const visibleRows = Math.max(4, budget - headerLines - footerLines);
			this.clampScroll(visibleRows);
			const shown = this.data.lines.slice(this.offset, this.offset + visibleRows);
			for (let i = 0; i < shown.length; i++) {
				const absoluteIndex = this.offset + i;
				const marker = absoluteIndex === this.selected ? this.theme.fg("accent", "› ") : "  ";
				const content = this.colorizeCommitLine(shown[i]!);
				const text = absoluteIndex === this.selected ? this.theme.bg("selectedBg", `${marker}${content}`) : `${marker}${content}`;
				lines.push(row(text));
			}
		}

		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));
		const hints = this.repos.length > 1
			? "↑↓/jk scroll • n/p repo • r refresh • q/esc close"
			: "↑↓/jk scroll • r refresh • q/esc close";
		lines.push(row(this.theme.fg("dim", hints)));
		lines.push(border("╰") + border("─".repeat(innerWidth)) + border("╯"));
		return lines;
	}

	invalidate(): void {}

	/** The repository the panel currently shows, for callers that reopen at the same place. */
	currentRepo(): GitRepo {
		return this.repos[this.index] ?? this.data.repo;
	}

	private async refresh(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.message = undefined;
		this.tui.requestRender();
		try {
			this.data = await loadGitGraph(this.pi, this.currentRepo(), this.limit);
			this.selected = Math.min(this.selected, Math.max(0, this.data.lines.length - 1));
			this.message = `refreshed ${this.data.loadedAt.toLocaleTimeString()}`;
		} catch (error) {
			this.message = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.tui.requestRender();
		}
	}

	private async switchRepository(delta: number): Promise<void> {
		if (this.loading || this.repos.length <= 1) return;
		this.index = (this.index + delta + this.repos.length) % this.repos.length;
		this.selected = 0;
		this.offset = 0;
		await this.refresh();
	}

	private ensureSelectedVisible(): void {
		const visibleRows = 20;
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + visibleRows) this.offset = this.selected - visibleRows + 1;
	}

	private clampScroll(visibleRows: number): void {
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + visibleRows) this.offset = this.selected - visibleRows + 1;
		const maxOffset = Math.max(0, this.data.lines.length - visibleRows);
		this.offset = Math.min(Math.max(0, this.offset), maxOffset);
	}

	private colorizeCommitLine(line: string): string {
		const match = line.match(/^([*|\\/ ]*)([0-9a-f]{5,})(.*)$/);
		if (!match) return this.theme.fg("toolOutput", line);
		const graph = this.theme.fg("accent", match[1] ?? "");
		const hash = this.theme.fg("warning", match[2] ?? "");
		const rest = this.colorizeRefs(match[3] ?? "");
		return `${graph}${hash}${rest}`;
	}

	private colorizeRefs(text: string): string {
		return text.replace(/\(([^)]+)\)/g, (_match, refs: string) => this.theme.fg("success", `(${refs})`));
	}
}

/**
 * Whether the host renders the panel itself rather than placing an overlay in a terminal.
 * pi-web runs sessions in RPC mode and mounts the component in a browser dialog, so the terminal
 * geometry an overlay would use does not apply.
 */
function isPanelHost(ctx: ExtensionContext): boolean {
	return ctx.mode !== "tui";
}

/** Arguments: an optional commit limit, an optional path, or `repos` to list them. */
type ParsedArgs = { limit: number; path?: string; listRepos: boolean };

export function parseArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let limit = DEFAULT_LIMIT;
	let path: string | undefined;
	let listRepos = false;
	for (const token of tokens) {
		if (/^\d+$/.test(token)) {
			const parsed = Number.parseInt(token, 10);
			// `0` is not a commit limit; the default stands, as it does for an empty argument.
			if (parsed > 0) limit = Math.min(parsed, MAX_LIMIT);
			continue;
		}
		if (token === "repos" || token === "--repos" || token === "-l") {
			listRepos = true;
			continue;
		}
		path = token;
	}
	return path === undefined ? { limit, listRepos } : { limit, path, listRepos };
}

/** Every repository reachable from the session directory, with the session's own first. */
async function resolveRepositories(pi: ExtensionAPI, cwd: string): Promise<GitRepo[]> {
	const own = await repositoryRootOf(pi, cwd);
	return discoverRepositories(cwd, own);
}

function repoLabel(repo: GitRepo, cwd: string): string {
	const relative = relativeTo(cwd, repo.root);
	return relative ? `${repo.name} — ${relative}` : `${repo.name} — ${repo.root}`;
}

function relativeTo(from: string, target: string): string | undefined {
	const base = resolve(from);
	const absolute = resolve(target);
	if (absolute === base) return ".";
	const prefix = base.endsWith(sep) ? base : base + sep;
	return absolute.startsWith(prefix) ? absolute.slice(prefix.length) : undefined;
}

async function showGitGraph(pi: ExtensionAPI, ctx: ExtensionContext, args: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Git graph requires a UI: run it in the Pi TUI or in Pi Web.", "warning");
		return;
	}
	const parsed = parseArgs(args);
	const cwd = ctx.cwd;

	let repos = await resolveRepositories(pi, cwd);

	if (parsed.listRepos) {
		if (repos.length === 0) {
			ctx.ui.notify(`No git repository found in or below ${cwd}.`, "info");
			return;
		}
		const lines = [`Repositories (${repos.length}):`];
		for (const repo of repos) lines.push(`  ${repoLabel(repo, cwd)}`);
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	// An explicit path narrows the panel to that repository, and to the repositories below it.
	if (parsed.path) {
		const target = resolve(cwd, parsed.path);
		const targetRoot = await repositoryRootOf(pi, target);
		if (!targetRoot) {
			ctx.ui.notify(`Not a git repository: ${target}`, "warning");
			return;
		}
		repos = discoverRepositories(target, targetRoot);
	}

	if (repos.length === 0) {
		ctx.ui.notify(`No git repository found in or below ${cwd}.`, "warning");
		return;
	}

	// One repository needs no question; several are the multi-repository case and the user picks.
	let index = 0;
	if (repos.length > 1 && !parsed.path) {
		const labels = repos.map((repo) => repoLabel(repo, cwd));
		const picked = await ctx.ui.select("Which repository?", labels);
		if (picked === undefined) return;
		const pickedIndex = labels.indexOf(picked);
		if (pickedIndex < 0) return;
		index = pickedIndex;
	}

	const repo = repos[index]!;
	const data = await loadGitGraph(pi, repo, parsed.limit);
	const compact = isPanelHost(ctx);

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new GitGraphSidebar({
				pi,
				tui,
				theme,
				cwd,
				limit: parsed.limit,
				repos,
				index,
				data,
				compact,
				done,
			}),
		compact
			? {
					// pi-web renders the component at the width it is given and scrolls the dialog, so a
					// fixed column count replaces the percentage a terminal overlay would use.
					overlayOptions: { width: 118 },
				}
			: {
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "42%",
						minWidth: 48,
						maxHeight: "95%",
						margin: { right: 1 },
						visible: (termWidth) => termWidth >= 90,
					},
				},
	);
}

export default function registerGitGraphSidebar(pi: ExtensionAPI): void {
	pi.registerCommand("git-graph", {
		description: "Open a Git Graph-style view of the repository history (n/p switches repository)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await showGitGraph(pi, ctx, args);
		},
	});

	pi.registerShortcut("ctrl+shift+g", {
		description: "Open git graph sidebar",
		handler: async (ctx: ExtensionContext) => {
			await showGitGraph(pi, ctx, "");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("git-graph", ctx.ui.theme.fg("dim", "⇧⌃G graph"));
	});
}
