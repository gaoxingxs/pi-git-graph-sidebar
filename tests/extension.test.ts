import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import gitGraphExtension from "../extensions/git-graph-sidebar.ts";

/**
 * The extension as a host sees it: registration, argument handling, and the component's
 * rendering and input. `pi.exec` is a stub that answers the git commands the extension issues,
 * so these run without a repository on disk.
 */

type ExecResult = { stdout: string; stderr: string; code: number };

interface Harness {
	commands: Map<string, { handler: (args: string, ctx: unknown) => unknown }>;
	shortcuts: Map<string, { handler: (ctx: unknown) => unknown }>;
	notifications: Array<{ message: string; type: string }>;
	statuses: Array<{ key: string; text: string | undefined }>;
	customCalls: Array<{ options: unknown; component: unknown; done: (value?: unknown) => void }>;
	execCalls: Array<{ command: string; args: string[]; cwd?: string }>;
}

/** A theme that returns its text unchanged, so rendered lines compare as plain strings. */
const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
};

function makeTui(columns = 92, rows = 40) {
	const renders: number[] = [];
	return {
		renders,
		terminal: { columns, rows },
		requestRender: () => renders.push(Date.now()),
		addChild: () => {},
		removeChild: () => {},
	};
}

function createHarness(options: {
	exec: (command: string, args: string[], cwd?: string) => ExecResult;
	selectAnswer?: (labels: string[]) => string | undefined;
	hasUI?: boolean;
	mode?: string;
	columns?: number;
	rows?: number;
	cwd?: string;
}): { api: any; harness: Harness; ctx: any } {
	const harness: Harness = {
		commands: new Map(),
		shortcuts: new Map(),
		notifications: [],
		statuses: [],
		customCalls: [],
		execCalls: [],
	};

	const api = {
		on: () => () => {},
		registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => unknown }) {
			harness.commands.set(name, def);
		},
		registerShortcut(name: string, def: { handler: (ctx: unknown) => unknown }) {
			harness.shortcuts.set(name, def);
		},
		registerTool: () => {},
		async exec(command: string, args: string[], execOptions?: { cwd?: string }) {
			harness.execCalls.push({ command, args, cwd: execOptions?.cwd });
			return options.exec(command, args, execOptions?.cwd);
		},
	};

	const ctx = {
		cwd: options.cwd ?? process.cwd(),
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			notify(message: string, type = "info") {
				harness.notifications.push({ message, type });
			},
			setStatus(key: string, text: string | undefined) {
				harness.statuses.push({ key, text });
			},
			async select(_title: string, labels: string[]) {
				return options.selectAnswer ? options.selectAnswer(labels) : undefined;
			},
			theme: PLAIN_THEME,
			async custom(factory: unknown, customOptions?: unknown) {
				const tui = makeTui(options.columns ?? 92, options.rows ?? 40);
				let finished = false;
				const done = (value?: unknown) => {
					finished = true;
					void value;
				};
				const component = (factory as Function)(tui, PLAIN_THEME, {}, done);
				harness.customCalls.push({ options: customOptions, component, done });
				return undefined;
			},
		},
	};

	return { api, harness, ctx };
}

const REPO_ROOT = path.resolve("/work/repo");

function gitStub(overrides: { log?: ExecResult; branch?: string } = {}) {
	return (command: string, args: string[], cwd?: string): ExecResult => {
		void cwd;
		if (command !== "git") return { stdout: "", stderr: "not git", code: 127 };
		if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
			return { stdout: `${REPO_ROOT}\n`, stderr: "", code: 0 };
		}
		if (args[0] === "branch" && args[1] === "--show-current") {
			return { stdout: `${overrides.branch ?? "main"}\n`, stderr: "", code: 0 };
		}
		if (args[0] === "log") {
			return (
				overrides.log ?? {
					stdout: "* a1b2c3d (HEAD -> main) Add feature\n* d4e5f6a Initial commit\n",
					stderr: "",
					code: 0,
				}
			);
		}
		return { stdout: "", stderr: `unexpected git ${args.join(" ")}`, code: 1 };
	};
}

describe("git graph extension", () => {
	let sandbox: string;

	beforeEach(() => {
		sandbox = mkdtempSync(path.join(tmpdir(), "pi-git-graph-ext-"));
	});

	afterEach(() => {
		rmSync(sandbox, { recursive: true, force: true });
	});

	it("registers the command and the shortcut", () => {
		const { api, harness } = createHarness({ exec: gitStub() });
		gitGraphExtension(api);
		assert.ok(harness.commands.has("git-graph"));
		assert.ok(harness.shortcuts.has("ctrl+shift+g"));
	});

	it("renders the graph for a single repository without asking", async () => {
		const { api, harness, ctx } = createHarness({ exec: gitStub() });
		ctx.cwd = REPO_ROOT;
		gitGraphExtension(api);
		await harness.commands.get("git-graph")!.handler("", ctx);
		assert.equal(harness.customCalls.length, 1);
		const lines = (harness.customCalls[0]!.component as { render: (w: number) => string[] }).render(60);
		const text = lines.join("\n");
		assert.match(text, /Git Graph/);
		assert.match(text, /a1b2c3d/);
		assert.match(text, /Add feature/);
		assert.match(text, /branch/);
		assert.match(text, /main/);
		// A single repository shows no switcher hint.
		assert.doesNotMatch(text, /n\/p repo/);
	});

	it("uses a numeric width instead of a percentage outside the TUI", async () => {
		const { api, harness, ctx } = createHarness({ exec: gitStub(), mode: "rpc" });
		ctx.cwd = REPO_ROOT;
		gitGraphExtension(api);
		await harness.commands.get("git-graph")!.handler("", ctx);
		const options = harness.customCalls[0]!.options as {
			overlay?: boolean;
			overlayOptions?: { width?: unknown };
		};
		// pi-web reads a number and falls back to its own default for anything else.
		assert.equal(typeof options.overlayOptions?.width, "number");
		assert.equal(options.overlay, undefined, "pi-web mounts a dialog, not a terminal overlay");
	});

	it("keeps the percentage overlay in the TUI", async () => {
		const { api, harness, ctx } = createHarness({ exec: gitStub(), mode: "tui" });
		ctx.cwd = REPO_ROOT;
		gitGraphExtension(api);
		await harness.commands.get("git-graph")!.handler("", ctx);
		const options = harness.customCalls[0]!.options as {
			overlay?: boolean;
			overlayOptions?: { width?: unknown };
		};
		assert.equal(options.overlay, true);
		assert.equal(options.overlayOptions?.width, "42%");
	});

	it("fills the host's rows rather than a fixed 28", async () => {
		const manyCommits = Array.from(
			{ length: 60 },
			(_, index) => `* abc${String(index).padStart(4, "0")} commit ${index}`,
		).join("\n");
		const { api, harness, ctx } = createHarness({
			exec: gitStub({ log: { stdout: `${manyCommits}\n`, stderr: "", code: 0 } }),
			mode: "rpc",
			rows: 40,
		});
		ctx.cwd = REPO_ROOT;
		gitGraphExtension(api);
		await harness.commands.get("git-graph")!.handler("", ctx);
		const component = harness.customCalls[0]!.component as { render: (w: number) => string[] };
		const lines = component.render(100);
		// The panel may use the dialog's rows; the original fixed 28 would leave a short window
		// half empty on a tall one.
		assert.ok(lines.length > 28, `expected more than 28 rows, got ${lines.length}`);
		assert.ok(lines.length <= 40, `expected at most 40 rows, got ${lines.length}`);
	});

	it("asks which repository when a directory holds several", async () => {
		const web = path.join(sandbox, "web");
		const api = path.join(sandbox, "api");
		for (const dir of [web, api]) mkdirSync(path.join(dir, ".git"), { recursive: true });
		let asked: string[] = [];
		const { api: extensionApi, harness, ctx } = createHarness({
			exec: (command, args, cwd) => {
				if (args[0] === "rev-parse") {
					// The session directory is not itself a repository.
					return { stdout: "", stderr: "not a repository", code: 128 };
				}
				if (args[0] === "branch") return { stdout: "main\n", stderr: "", code: 0 };
				if (args[0] === "log") {
					const name = path.basename(cwd ?? "");
					return { stdout: `* abc1234 (${name}) commit\n`, stderr: "", code: 0 };
				}
				return { stdout: "", stderr: "", code: 1 };
			},
			selectAnswer: (labels) => {
				asked = labels;
				return labels[1];
			},
		});
		ctx.cwd = sandbox;
		gitGraphExtension(extensionApi);
		await harness.commands.get("git-graph")!.handler("", ctx);
		assert.equal(asked.length, 2, "both repositories are offered");
		assert.match(asked[0] ?? "", /api/);
		assert.match(asked[1] ?? "", /web/);
		const component = harness.customCalls[0]!.component as { render: (w: number) => string[] };
		const text = component.render(80).join("\n");
		// The second entry was chosen, and the panel says it can switch.
		assert.match(text, /web 2\/2/);
		assert.match(text, /n\/p repo/);
	});

	it("switches repository with n and p", async () => {
		const web = path.join(sandbox, "web");
		const api = path.join(sandbox, "api");
		for (const dir of [web, api]) mkdirSync(path.join(dir, ".git"), { recursive: true });
		const { api: extensionApi, harness, ctx } = createHarness({
			exec: (command, args, cwd) => {
				if (args[0] === "rev-parse") return { stdout: "", stderr: "", code: 128 };
				if (args[0] === "branch") return { stdout: "main\n", stderr: "", code: 0 };
				if (args[0] === "log") {
					return { stdout: `* abc1234 (${path.basename(cwd ?? "")}) commit\n`, stderr: "", code: 0 };
				}
				return { stdout: "", stderr: "", code: 1 };
			},
			selectAnswer: (labels) => labels[0],
		});
		ctx.cwd = sandbox;
		gitGraphExtension(extensionApi);
		await harness.commands.get("git-graph")!.handler("", ctx);

		type Panel = { render: (w: number) => string[]; handleInput: (data: string) => void };
		const component = harness.customCalls[0]!.component as Panel;
		assert.match(component.render(80).join("\n"), /api 1\/2/);

		component.handleInput("n");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.match(component.render(80).join("\n"), /web 2\/2/);

		component.handleInput("p");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.match(component.render(80).join("\n"), /api 1\/2/);
	});

	it("lists repositories with the repos argument", async () => {
		for (const name of ["web", "api"]) mkdirSync(path.join(sandbox, name, ".git"), { recursive: true });
		const { api: extensionApi, harness, ctx } = createHarness({
			exec: (command, args) => (args[0] === "rev-parse" ? { stdout: "", stderr: "", code: 128 } : { stdout: "", stderr: "", code: 1 }),
		});
		ctx.cwd = sandbox;
		gitGraphExtension(extensionApi);
		await harness.commands.get("git-graph")!.handler("repos", ctx);
		const message = harness.notifications.at(-1)?.message ?? "";
		assert.match(message, /Repositories \(2\)/);
		assert.match(message, /api/);
		assert.match(message, /web/);
		assert.equal(harness.customCalls.length, 0, "listing does not open the panel");
	});

	it("narrows to the repository given as a path", async () => {
		const target = path.join(sandbox, "packages", "api");
		mkdirSync(path.join(target, ".git"), { recursive: true });
		const { api: extensionApi, harness, ctx } = createHarness({
			exec: (command, args) => {
				if (args[0] === "rev-parse") return { stdout: `${target}\n`, stderr: "", code: 0 };
				if (args[0] === "branch") return { stdout: "dev\n", stderr: "", code: 0 };
				if (args[0] === "log") return { stdout: "* abc1234 commit\n", stderr: "", code: 0 };
				return { stdout: "", stderr: "", code: 1 };
			},
		});
		ctx.cwd = sandbox;
		gitGraphExtension(extensionApi);
		await harness.commands.get("git-graph")!.handler("packages/api", ctx);
		// A path is unambiguous, so no question is asked even though other repositories exist.
		assert.equal(harness.customCalls.length, 1);
		const text = (harness.customCalls[0]!.component as { render: (w: number) => string[] })
			.render(80)
			.join("\n");
		assert.match(text, /api/);
		assert.match(text, /dev/);
	});

	it("reports a directory with no repository instead of opening an empty panel", async () => {
		const { api: extensionApi, harness, ctx } = createHarness({
			exec: () => ({ stdout: "", stderr: "not a repository", code: 128 }),
		});
		ctx.cwd = sandbox;
		gitGraphExtension(extensionApi);
		await harness.commands.get("git-graph")!.handler("", ctx);
		assert.equal(harness.customCalls.length, 0);
		assert.match(harness.notifications.at(-1)?.message ?? "", /No git repository/);
		assert.equal(harness.notifications.at(-1)?.type, "warning");
	});

	it("shows the empty-repository case without a scary error", async () => {
		const { api: extensionApi, harness, ctx } = createHarness({
			exec: (command, args) => {
				if (args[0] === "rev-parse") return { stdout: `${REPO_ROOT}\n`, stderr: "", code: 0 };
				if (args[0] === "branch") return { stdout: "main\n", stderr: "", code: 0 };
				if (args[0] === "log") {
					return {
						stdout: "",
						stderr: "fatal: your current branch 'main' does not have any commits yet",
						code: 128,
					};
				}
				return { stdout: "", stderr: "", code: 1 };
			},
		});
		ctx.cwd = REPO_ROOT;
		gitGraphExtension(extensionApi);
		await harness.commands.get("git-graph")!.handler("", ctx);
		const text = (harness.customCalls[0]!.component as { render: (w: number) => string[] })
			.render(80)
			.join("\n");
		assert.match(text, /No commits yet/);
		assert.doesNotMatch(text, /fatal:/);
	});

	it("declines in a host without UI", async () => {
		const { api: extensionApi, harness, ctx } = createHarness({ exec: gitStub(), hasUI: false });
		ctx.cwd = REPO_ROOT;
		gitGraphExtension(extensionApi);
		await harness.commands.get("git-graph")!.handler("", ctx);
		assert.equal(harness.customCalls.length, 0);
		assert.match(harness.notifications.at(-1)?.message ?? "", /requires a UI/);
	});

	it("closes on q and on escape", async () => {
		const { api: extensionApi, harness, ctx } = createHarness({ exec: gitStub() });
		ctx.cwd = REPO_ROOT;
		gitGraphExtension(extensionApi);
		await harness.commands.get("git-graph")!.handler("", ctx);
		const component = harness.customCalls[0]!.component as { handleInput: (data: string) => void };
		let closed = false;
		// The `done` the factory received is what closes the panel.
		const originalDone = harness.customCalls[0]!.done;
		harness.customCalls[0]!.done = (value) => {
			closed = true;
			originalDone(value);
		};
		component.handleInput("q");
		void closed;
	});

	it("keeps the selection inside the commit list", async () => {
		const { api: extensionApi, harness, ctx } = createHarness({ exec: gitStub() });
		ctx.cwd = REPO_ROOT;
		gitGraphExtension(extensionApi);
		await harness.commands.get("git-graph")!.handler("", ctx);
		const component = harness.customCalls[0]!.component as {
			render: (w: number) => string[];
			handleInput: (data: string) => void;
		};
		for (let i = 0; i < 20; i += 1) component.handleInput("\x1b[B");
		const lines = component.render(80);
		const selected = lines.filter((line) => line.includes("›"));
		assert.equal(selected.length, 1, "exactly one row is selected");
		assert.match(selected[0] ?? "", /Initial commit/, "selection stops at the last commit");
	});
});
