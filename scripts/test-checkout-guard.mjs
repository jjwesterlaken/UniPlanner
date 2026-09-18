/* The copy-aside rule, as a mechanism rather than a memory.

   THE CLAIM: `git checkout` and `git restore` against a path that has
   uncommitted changes are REFUSED, with an explanation naming a
   remedy; every other shape of those commands, and everything else, is
   allowed.

   WHY IT IS TESTED IN TWO LAYERS, which is the artifact rule:

   - The SHAPE BATTERY drives `decide()` over a fake repository, so the
     awkward cases are a table rather than something only a real
     working tree can reach — the `audioSources.js` arrangement. It is
     the only way to cover `--ours` during a merge, or a `cd` into a
     subdirectory, without staging each one for real.
   - THE REAL SCRIPT is then spawned against a REAL git repository with
     a REAL dirty file, fed the REAL PreToolUse payload, and its stdout
     is parsed as the hook protocol. A battery over exported functions
     says nothing about whether the shipped script reads stdin, finds
     the repository, or emits JSON anybody honours.

   Both halves carry their control. "Nothing is allowed" satisfies
   every must-block assertion and "nothing is blocked" satisfies every
   must-allow one, so each table asserts the other answer exists, and
   the real-script section runs the SAME command shape against a CLEAN
   file and requires it through.

   Run via `npm test`. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decide, readCd, readGitCommand, reasonFor, segments, tokenise } from "../.claude/hooks/guard-dirty-checkout.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const HOOK = path.join(rootDir, ".claude/hooks/guard-dirty-checkout.mjs");
const SETTINGS = path.join(rootDir, ".claude/settings.json");
const read = (p) => fs.readFileSync(path.join(rootDir, p), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") throw new Error("this runner is synchronous");
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL  - ${name}`);
    console.error(`        ${err.message}`);
  }
}

/* ==================================================================
   1. THE SHAPE BATTERY, over a fake repository.
   ================================================================== */

const ROOT = "/repo";
const TRACKED = new Set(["/repo", "/repo/dirty.js", "/repo/clean.js", "/repo/site", "/repo/site/dirty.js"]);
const DIRTY = new Set(["/repo/dirty.js", "/repo/site/dirty.js"]);
const REFS = new Set(["main", "HEAD", "origin/main", "release", "43e10ec"]);

const world = {
  root: ROOT,
  isRef: (w) => REFS.has(w),
  isPath: (abs) => TRACKED.has(abs),
  dirty: (abs) => [...DIRTY].filter((f) => f === abs || f.startsWith(`${abs}/`)),
};

/* MUST BLOCK — every shape that overwrites a dirty working-tree file. */
const MUST_BLOCK = [
  ["the plain form, which is the one that has cost work twice", "git checkout dirty.js"],
  ["the explicit pathspec form", "git checkout -- dirty.js"],
  ["restore, which is the modern spelling of the same thing", "git restore dirty.js"],
  ["restore naming the worktree", "git restore --worktree dirty.js"],
  ["restore taking BOTH, which destroys staged work as well", "git restore --staged --worktree dirty.js"],
  ["a whole directory", "git checkout ."],
  ["from a commit rather than the index", "git checkout HEAD -- dirty.js"],
  ["from a branch", "git checkout main -- dirty.js"],
  ["forced", "git checkout -f dirty.js"],
  ["quoted", 'git checkout "dirty.js"'],
  ["THE COMPOUND SHAPE — the one an `if: Bash(git *)` prefix filter misses", "cd site && git checkout dirty.js"],
  ["after something else succeeded", "npm test && git checkout dirty.js"],
  ["after something else failed", "npm test || git checkout dirty.js"],
  ["on its own line", "npm run build\ngit checkout dirty.js"],
  ["semicolon-joined", "echo one; git restore dirty.js"],
  ["with an absolute path", "git checkout -- /repo/dirty.js"],
];

/* MUST ALLOW — everything else, including the shapes of these two
   commands that cannot overwrite anything. */
const MUST_ALLOW = [
  ["a branch switch", "git checkout main"],
  ["a branch switch by sha", "git checkout 43e10ec"],
  ["a remote-tracking ref", "git checkout origin/main"],
  ["creating a branch", "git checkout -b claude/something"],
  ["re-pointing a branch, which is how this repo starts one", "git checkout -B claude/x origin/main"],
  ["AN INDEX-ONLY RESTORE, which leaves the file on disk untouched", "git restore --staged dirty.js"],
  ["picking a side during a merge, where the dirty state IS the conflict", "git checkout --ours dirty.js"],
  ["the other side", "git checkout --theirs dirty.js"],
  ["a file with nothing uncommitted in it", "git checkout clean.js"],
  ["a clean file, explicitly", "git checkout -- clean.js"],
  ["reading the state", "git status --porcelain"],
  ["the remedy the refusal names", "git stash push -- dirty.js"],
  ["committing", "git commit -am 'the real work'"],
  ["anything that is not git", "npm test"],
  ["the words inside a quoted string are not a command", 'echo "git checkout dirty.js"'],
  ["a path that is not tracked", "git checkout untracked.js"],
];

test("the battery covers both answers — neither table is the whole of it", () => {
  assert.ok(MUST_BLOCK.length >= 10, `only ${MUST_BLOCK.length} must-block shapes`);
  assert.ok(MUST_ALLOW.length >= 10, `only ${MUST_ALLOW.length} must-allow shapes`);
  /* A guard that refuses everything satisfies every must-block row,
     and one that refuses nothing satisfies every must-allow row. Both
     tables running against one implementation is what separates them,
     so both must be non-empty and both must be exercised below. */
});

for (const [why, command] of MUST_BLOCK) {
  test(`REFUSED: ${why}`, () => {
    const verdict = decide(command, world);
    assert.equal(verdict.block, true, `allowed through: ${command}`);
    assert.ok(verdict.files.length > 0, "blocked without naming what is dirty");
  });
}

for (const [why, command] of MUST_ALLOW) {
  test(`allowed: ${why}`, () => {
    const verdict = decide(command, world);
    assert.equal(verdict.block, false, `refused: ${command}`);
  });
}

/* ==================================================================
   2. THE PARSING, where the interesting mistakes live.
   ================================================================== */

test("a valued flag's value is not mistaken for a pathspec", () => {
  /* `git checkout -b dirty.js` creates a BRANCH called dirty.js. Read
     as a pathspec it would be refused, and the refusal would be about
     a file the command never touches. */
  const parsed = readGitCommand("git checkout -b dirty.js", world);
  assert.deepEqual(parsed.paths, []);
});

test("git's own options before the subcommand are skipped", () => {
  const parsed = readGitCommand("git --no-pager checkout main", world);
  assert.equal(parsed.sub, "checkout");
});

test("a `cd` with a variable in it does not move the working directory — it fails open", () => {
  /* The quotes come off and `$DIR` is not a literal directory, so
     guessing where the command runs would be worse than admitting we
     do not know. Not knowing resolves the pathspec to nothing, and
     nothing is allowed. */
  assert.equal(readCd('cd "$DIR"'), null);
  assert.equal(readCd("cd -"), null);
  assert.equal(readCd("cd site"), "site");
  assert.equal(decide('cd "$DIR" && git checkout dirty.js', world).block, true, "the repo-root reading still catches this one");
});

test("the separator splits a compound command into its parts", () => {
  assert.deepEqual(segments("a && b || c; d | e"), ["a", "b", "c", "d", "e"]);
});

test("tokenising respects quotes", () => {
  assert.deepEqual(tokenise('git checkout "a b.js"'), ["git", "checkout", "a b.js"]);
});

test("the refusal names the file, the remedy, and the way to switch it off", () => {
  const reason = reasonFor({ sub: "checkout", spec: "scripts/x.mjs", files: ["scripts/x.mjs"] });
  assert.match(reason, /REFUSED/);
  assert.match(reason, /scripts\/x\.mjs/);
  assert.match(reason, /copy the file aside FIRST/);
  assert.match(reason, /git stash push -- scripts\/x\.mjs/);
  assert.match(reason, /\.claude\/settings\.json/, "a block with no way through is one that gets deleted");
});

/* ==================================================================
   3. THE REAL SCRIPT, against a REAL repository.

   Everything above is a claim about exported functions. This is the
   artifact: the shipped file, spawned as the hook, reading the hook's
   stdin payload and writing the hook's protocol back.
   ================================================================== */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-guard-"));
const run = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function scratchRepo() {
  const dir = fs.mkdtempSync(path.join(tmp, "repo-"));
  run(["init", "-q", "-b", "main"], dir);
  run(["config", "user.email", "guard@example.test"], dir);
  run(["config", "user.name", "guard"], dir);
  fs.writeFileSync(path.join(dir, "dirty.js"), "committed\n");
  fs.writeFileSync(path.join(dir, "clean.js"), "committed\n");
  run(["add", "-A"], dir);
  run(["commit", "-qm", "first"], dir);
  fs.appendFileSync(path.join(dir, "dirty.js"), "// an hour of uncommitted work\n");
  return dir;
}

function askTheHook(command, { projectDir, input } = {}) {
  const payload = input ?? JSON.stringify({ session_id: "t", tool_name: "Bash", tool_input: { command } });
  const env = { ...process.env };
  if (projectDir) env.CLAUDE_PROJECT_DIR = projectDir;
  else delete env.CLAUDE_PROJECT_DIR;
  const r = spawnSync(process.execPath, [HOOK], { input: payload, encoding: "utf8", env });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: r.stderr || "" };
}

const repo = scratchRepo();

test("THE REAL HOOK REFUSES A REAL DIRTY FILE, and the refusal is the hook protocol", () => {
  const { status, stdout } = askTheHook("git checkout dirty.js", { projectDir: repo });
  assert.equal(status, 0, "a hook that exits non-zero is an error, not a decision");
  assert.ok(stdout, "the hook said nothing at all");
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.match(reason, /dirty\.js/, "refused without naming the file");
  assert.match(reason, /copy the file aside FIRST/, "refused without naming the remedy");
});

test("THE CONTROL: the same command shape against a CLEAN file goes through", () => {
  /* Without this, "the hook denies" is satisfied by a hook that denies
     everything — which would be indistinguishable from a working guard
     until the first time somebody needed a checkout. */
  const { status, stdout } = askTheHook("git checkout clean.js", { projectDir: repo });
  assert.equal(status, 0);
  assert.equal(stdout, "", `refused a clean file: ${stdout}`);
});

test("the real hook allows a branch switch in a repository with a dirty file in it", () => {
  const { stdout } = askTheHook("git checkout -b claude/something", { projectDir: repo });
  assert.equal(stdout, "", `refused a branch creation: ${stdout}`);
});

test("the real hook catches the compound form a prefix filter would miss", () => {
  const sub = path.join(repo, "site");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "nested.js"), "committed\n");
  run(["add", "-A"], repo);
  run(["commit", "-qm", "nested"], repo);
  fs.appendFileSync(path.join(sub, "nested.js"), "// uncommitted\n");
  const { stdout } = askTheHook("cd site && git checkout nested.js", { projectDir: repo });
  assert.ok(stdout, "a `cd` into a subdirectory walked straight past the guard");
  assert.match(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason, /nested\.js/);
});

test("IT FAILS OPEN: malformed stdin, an empty payload, and a directory that is not a repository", () => {
  /* A safety net against a known reflex, not a security boundary.
     Anything that can run `git checkout` can run a hundred other
     destructive things, and a guard that breaks and blocks everything
     is a guard somebody switches off. */
  assert.equal(askTheHook(null, { projectDir: repo, input: "not json at all" }).stdout, "");
  assert.equal(askTheHook(null, { projectDir: repo, input: "{}" }).stdout, "");
  const notARepo = fs.mkdtempSync(path.join(tmp, "bare-"));
  fs.writeFileSync(path.join(notARepo, "dirty.js"), "x\n");
  assert.equal(askTheHook("git checkout dirty.js", { projectDir: notARepo }).stdout, "");
});

test("the hook writes nothing to stderr on the path it allows", () => {
  /* Hook stderr is surfaced. A guard that chatters on every Bash call
     is one somebody switches off for being noisy, which costs exactly
     as much as one that blocks too much. */
  const { stderr } = askTheHook("npm test", { projectDir: repo });
  assert.equal(stderr.trim(), "");
});

/* ==================================================================
   4. THE WIRING. A correct hook that is not registered is a file.
   ================================================================== */

test("settings.json registers the hook on PreToolUse/Bash, and the file it names exists", () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  const entries = settings.hooks?.PreToolUse || [];
  const bash = entries.filter((e) => String(e.matcher || "").split("|").includes("Bash"));
  assert.ok(bash.length > 0, "no PreToolUse hook matches Bash");
  const commands = bash.flatMap((e) => (e.hooks || []).map((h) => h.command || ""));
  assert.ok(commands.length > 0, "the Bash matcher carries no hooks");
  /* DERIVED: the path is read out of the settings and resolved, rather
     than the test restating where the file ought to be. */
  const named = commands.find((c) => /guard-dirty-checkout\.mjs/.test(c));
  assert.ok(named, `no registered hook runs the guard: ${commands.join(" | ")}`);
  const file = named.match(/(\S*guard-dirty-checkout\.mjs)/)[1];
  assert.ok(fs.existsSync(path.join(rootDir, file)), `settings names ${file}, which is not there`);
});

test("THE HOOK CARRIES NO `if` FILTER, because a prefix match misses the compound form", () => {
  /* `if: "Bash(git *)"` is a PREFIX match. `cd somewhere && git
     checkout x` does not start with `git`, and that is precisely the
     shape these commands take — so the filter would have made the
     guard green and blind. The cost of dropping it is that the hook
     runs on every Bash call; it is a few milliseconds of `git status`
     and it is the difference between a guard and a decoration. */
  const settings = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  for (const entry of settings.hooks?.PreToolUse || []) {
    for (const hook of entry.hooks || []) {
      if (!/guard-dirty-checkout\.mjs/.test(hook.command || "")) continue;
      assert.equal(hook.if, undefined, `the guard grew an \`if\` filter: ${hook.if}`);
    }
  }
});

test("git really tracks the shared halves, and really ignores the personal one", () => {
  /* `.claude/` used to be ignored as a DIRECTORY, which makes every
     negation inside it inert — so the entry can look right and still
     not bite. That is the keystore lesson: ask git, do not read the
     file. */
  const ignored = (p) => {
    const r = spawnSync("git", ["check-ignore", "-q", p], { cwd: rootDir });
    return r.status === 0;
  };
  assert.equal(ignored(".claude/hooks/guard-dirty-checkout.mjs"), false, "the guard is ignored, so nobody else gets it");
  assert.equal(ignored(".claude/settings.json"), false, "the wiring is ignored, so the guard is never registered");
  assert.equal(ignored(".claude/settings.local.json"), true, "a personal settings file would be committed");
});

test("npm test runs this file", () => {
  assert.match(JSON.parse(read("package.json")).scripts.test, /test-checkout-guard\.mjs/);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
if (passed === 0) {
  console.error("no results at all — treating that as a failure");
  process.exit(1);
}
