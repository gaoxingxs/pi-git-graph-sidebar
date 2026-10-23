import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { discoverRepositories, parseArgs } from "../extensions/git-graph-sidebar.ts";

/**
 * Repository discovery and argument parsing. Rendering needs a TUI and is covered by the
 * extension tests; these check the part that decides *what* the panel shows.
 */

function makeRepo(dir: string, options: { worktreeFile?: boolean } = {}): void {
	mkdirSync(dir, { recursive: true });
	if (options.worktreeFile) {
		// A linked worktree and a submodule both record `.git` as a file.
		writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n", "utf8");
		return;
	}
	mkdirSync(path.join(dir, ".git"), { recursive: true });
}

describe("discoverRepositories", () => {
	let sandbox: string;

	beforeEach(() => {
		sandbox = mkdtempSync(path.join(tmpdir(), "pi-git-graph-"));
	});

	afterEach(() => {
		rmSync(sandbox, { recursive: true, force: true });
	});

	it("finds sibling repositories in a workspace directory", () => {
		makeRepo(path.join(sandbox, "web"));
		makeRepo(path.join(sandbox, "api"));
		makeRepo(path.join(sandbox, "docs"));
		const repos = discoverRepositories(sandbox);
		assert.deepEqual(
			repos.map((repo) => repo.name),
			["api", "docs", "web"],
		);
		assert.equal(repos[0]?.root, path.join(sandbox, "api"));
	});

	it("puts the session's own repository first", () => {
		const own = path.join(sandbox, "main");
		makeRepo(own);
		makeRepo(path.join(sandbox, "other"));
		const repos = discoverRepositories(own, own);
		assert.equal(repos[0]?.name, "main");
		assert.equal(repos.length, 1, "a repository is not descended into for nested checkouts");
	});

	it("finds nested repositories below the session's own repository", () => {
		const own = path.join(sandbox, "monorepo");
		makeRepo(own);
		makeRepo(path.join(own, "packages", "a"));
		makeRepo(path.join(own, "packages", "b"));
		const repos = discoverRepositories(own, own);
		assert.deepEqual(
			repos.map((repo) => repo.name),
			["monorepo", "a", "b"],
		);
	});

	it("recognises a .git file, as linked worktrees and submodules use", () => {
		makeRepo(path.join(sandbox, "worktree"), { worktreeFile: true });
		const repos = discoverRepositories(sandbox);
		assert.deepEqual(
			repos.map((repo) => repo.name),
			["worktree"],
		);
	});

	it("skips dependency and build directories", () => {
		makeRepo(path.join(sandbox, "app"));
		makeRepo(path.join(sandbox, "node_modules", "dep"));
		makeRepo(path.join(sandbox, "dist", "bundle"));
		makeRepo(path.join(sandbox, ".cache", "hidden"));
		const repos = discoverRepositories(sandbox);
		assert.deepEqual(
			repos.map((repo) => repo.name),
			["app"],
		);
	});

	it("returns nothing for a directory without repositories", () => {
		mkdirSync(path.join(sandbox, "empty"), { recursive: true });
		assert.deepEqual(discoverRepositories(path.join(sandbox, "empty")), []);
	});

	it("stops at the depth limit", () => {
		// depth 0 is the session directory, so a repository four levels down is out of reach.
		makeRepo(path.join(sandbox, "a", "b", "c", "deep"));
		assert.deepEqual(discoverRepositories(sandbox), []);
		makeRepo(path.join(sandbox, "a", "b", "shallow"));
		assert.deepEqual(
			discoverRepositories(sandbox).map((repo) => repo.name),
			["shallow"],
		);
	});

	it("does not descend into a found repository", () => {
		makeRepo(path.join(sandbox, "outer"));
		makeRepo(path.join(sandbox, "outer", "inner"));
		// `outer` is not the session's own repository, so its tree is not walked.
		const repos = discoverRepositories(sandbox);
		assert.deepEqual(
			repos.map((repo) => repo.name),
			["outer"],
		);
	});
});

describe("parseArgs", () => {
	it("defaults to the default limit", () => {
		assert.deepEqual(parseArgs(""), { limit: 120, listRepos: false });
	});

	it("reads a commit limit", () => {
		assert.deepEqual(parseArgs("200"), { limit: 200, listRepos: false });
	});

	it("clamps the limit", () => {
		assert.equal(parseArgs("0").limit, 120, "zero is not a limit, so the default stands");
		assert.equal(parseArgs("9999").limit, 500);
	});

	it("reads a path", () => {
		assert.deepEqual(parseArgs("../other-repo"), {
			limit: 120,
			path: "../other-repo",
			listRepos: false,
		});
	});

	it("reads a limit and a path together", () => {
		assert.deepEqual(parseArgs("50 packages/api"), {
			limit: 50,
			path: "packages/api",
			listRepos: false,
		});
	});

	it("reads the repository listing flag", () => {
		assert.equal(parseArgs("repos").listRepos, true);
		assert.equal(parseArgs("--repos").listRepos, true);
	});
});
