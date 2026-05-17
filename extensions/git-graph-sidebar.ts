import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

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

type GitGraphData = {
	cwd: string;
	branch: string;
	lines: string[];
	error?: string;
	loadedAt: Date;
};

const DEFAULT_LIMIT = 120;
const MAX_LIMIT = 500;

function parseLimit(args: string): number {
	const trimmed = args.trim();
	if (!trimmed) return DEFAULT_LIMIT;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
	return Math.min(parsed, MAX_LIMIT);
}

async function loadGitGraph(pi: ExtensionAPI, cwd: string, limit: number): Promise<GitGraphData> {
	const common = { cwd, loadedAt: new Date() };
	const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3000 });
	if (root.code !== 0) {
		return {
			...common,
			branch: "",
			lines: [],
			error: "Not inside a git repository.",
		};
	}

	const branchResult = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 3000 });
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
		{ cwd, timeout: 8000 },
	);

	if (log.code !== 0) {
		return {
			...common,
			branch,
			lines: [],
			error: log.stderr.trim() || "git log failed.",
		};
	}

	return {
		...common,
		branch,
		lines: log.stdout.split("\n").filter((line) => line.trim().length > 0),
	};
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
	private data: GitGraphData;
	private readonly done: () => void;

	constructor(
		pi: ExtensionAPI,
		tui: TUI,
		theme: Theme,
		cwd: string,
		limit: number,
		data: GitGraphData,
		done: () => void,
	) {
		this.pi = pi;
		this.tui = tui;
		this.theme = theme;
		this.cwd = cwd;
		this.limit = limit;
		this.data = data;
		this.done = done;
	}

	handleInput(data: string): void {
		if (isKey(data, "escape") || isKey(data, "q") || isKey(data, "ctrlC")) {
			this.done();
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
		lines.push(row(`${this.theme.fg("dim", "branch")} ${this.theme.fg("success", this.data.branch || "-")} ${this.theme.fg("dim", `• ${this.data.lines.length}/${this.limit}`)}`));
		lines.push(row(this.theme.fg("dim", `cwd ${this.cwd}`)));
		lines.push(border("├") + border("─".repeat(innerWidth)) + border("┤"));

		if (this.loading) {
			lines.push(row(`${this.theme.fg("accent", "⟳")} refreshing…`));
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
			const visibleRows = Math.max(4, 28 - headerLines - footerLines);
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
		lines.push(row(this.theme.fg("dim", "↑↓/jk scroll • r refresh • q/esc close")));
		lines.push(border("╰") + border("─".repeat(innerWidth)) + border("╯"));
		return lines;
	}

	invalidate(): void {}

	private async refresh(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.message = undefined;
		this.tui.requestRender();
		try {
			this.data = await loadGitGraph(this.pi, this.cwd, this.limit);
			this.selected = Math.min(this.selected, Math.max(0, this.data.lines.length - 1));
			this.message = `refreshed ${this.data.loadedAt.toLocaleTimeString()}`;
		} catch (error) {
			this.message = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
			this.tui.requestRender();
		}
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

async function showGitGraph(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Git graph sidebar requires interactive TUI mode.", "warning");
		return;
	}
	const limit = parseLimit(args);
	const data = await loadGitGraph(pi, ctx.cwd, limit);
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => new GitGraphSidebar(pi, tui, theme, ctx.cwd, limit, data, done), {
		overlay: true,
		overlayOptions: {
			anchor: "right-center",
			width: "42%",
			minWidth: 48,
			maxHeight: "95%",
			margin: { right: 1 },
			visible: (termWidth) => termWidth >= 90,
		},
	});
}

export default function registerGitGraphSidebar(pi: ExtensionAPI): void {
	pi.registerCommand("git-graph", {
		description: "Open a VS Code Git Graph-style sidebar for the current repository",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await showGitGraph(pi, ctx, args);
		},
	});

	pi.registerShortcut("ctrl+shift+g", {
		description: "Open git graph sidebar",
		handler: async (ctx: ExtensionCommandContext) => {
			await showGitGraph(pi, ctx, "");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("git-graph", ctx.ui.theme.fg("dim", "⇧⌃G graph"));
	});
}
