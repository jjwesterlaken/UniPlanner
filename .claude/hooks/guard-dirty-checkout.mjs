#!/usr/bin/env node
/* ==================================================================
   guard-dirty-checkout.mjs — refuse `git checkout` / `git restore`
   against a path that has uncommitted changes.

   WHY THIS EXISTS, and it is one line of CLAUDE.md turned into a
   mechanism: `git checkout <file>` reverts to the last COMMIT, not to
   what was in the working tree a second ago. Used to undo a deliberate
   mutation on a file that also carries an hour of uncommitted work, it
   throws the work away and restores something that builds — no error,
   no conflict, and a file that looks plausible.

   It has now cost work twice on this project. The rule was written
   down after the first time and REMEMBERED rather than enforced, so
   the second time happened anyway — during mutation-checking, which is
   exactly when the rule applies and exactly when attention is
   somewhere else. A rule that has to be remembered at the one moment
   attention is elsewhere is not a rule, it is a hope.

   ------------------------------------------------------------------
   WHY A HOOK AND NOT A TEST.

   Nothing in `npm test` can see this. The damage is to the WORKING
   TREE, before any test runs; afterwards the file either still builds
   (so nothing fails) or does not (so the failure names a syntax error
   rather than a lost hour). And git has no `pre-checkout` hook for a
   pathspec checkout, so the version-control layer cannot veto it
   either. A PreToolUse hook is the only layer that sees the command
   before it runs.

   ------------------------------------------------------------------
   IT EXPLAINS RATHER THAN VETOES, and the remedy it names is the
   point. `git stash push -- <file>` has the same effect as `git
   checkout -- <file>` and is RECOVERABLE, so there is always a correct
   thing to do instead. A block with no way through is one that gets
   deleted the first time it is inconvenient.

   ------------------------------------------------------------------
   IT FAILS OPEN. Every internal error — git missing, a command shape
   it cannot parse, a path outside this repository — allows the
   command. This is a safety net against a known reflex, not a security
   boundary: anything that can run `git checkout` can run a hundred
   other destructive things, and a guard that breaks and blocks
   everything is a guard somebody switches off.

   ------------------------------------------------------------------
   WHAT IT CANNOT SEE, said here rather than implied by a pass:

   - A path reached through a shell construct it does not evaluate: a
     variable (`git checkout $f`), a glob the shell expands, command
     substitution, a heredoc. It reads the literal words.
   - A `cd` that is not a plain literal, so the working directory it
     assumes is wrong and the pathspec resolves to nothing. That reads
     as "not a tracked path" and ALLOWS.
   - Anything destructive that is not these two subcommands: `git
     reset --hard`, `git clean -fd`, `git stash` without a pop, a
     `sed -i` over the wrong file, `>` over a file. It is scoped to the
     one reflex that has actually cost work here, twice.

   Every one of those fails OPEN, which is the direction chosen above.
   ================================================================== */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The repository this guard is asking about.
 *
 * `CLAUDE_PROJECT_DIR` is what Claude Code sets for a hook, and it is
 * the right answer when the hook lives somewhere other than the project
 * (a user-level `~/.claude/hooks/`). Falling back to the script's own
 * location keeps it working when it is not set at all.
 *
 * Read at CALL time rather than at import, so the test can point the
 * real script at a scratch repository and watch it refuse for real —
 * the artifact rule, which wants the shipped script exercised rather
 * than a re-implementation of its decision.
 */
export const repoRoot = () => process.env.CLAUDE_PROJECT_DIR || HERE;

/* ---------- parsing ---------- */

/** Split a shell string into words, respecting quotes. Good enough for argv shapes. */
export function tokenise(segment) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < segment.length; i += 1) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else {
        cur += c;
        has = true;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

/**
 * The separate commands inside one Bash invocation.
 *
 * THE COMPOUND SHAPE IS THE ONE THAT MATTERS. An earlier draft filtered
 * the hook with `if: "Bash(git *)"`, which is a PREFIX match — so
 * `cd somewhere && git checkout x` never reached the guard at all, and
 * that is precisely the shape these commands take.
 */
export const segments = (command) =>
  String(command || "")
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter(Boolean);

/* Flags that take a value, so the value is not mistaken for a
   pathspec. `-b newbranch` is the one that would otherwise look like a
   file nobody has. */
const VALUED = new Set(["-b", "-B", "-c", "-C", "--orphan", "--conflict", "-s", "--source", "--pathspec-from-file"]);

/**
 * What a single command segment is asking git to do.
 *
 * `paths` is what would be overwritten in the working tree, and is
 * empty for every shape that cannot overwrite anything: a branch
 * switch, a branch creation, an index-only restore.
 */
export function readGitCommand(segment, { isRef = () => false, isPath = () => false } = {}) {
  const words = tokenise(segment);
  const gitAt = words.findIndex((w) => w === "git" || w.endsWith("/git"));
  if (gitAt < 0) return null;

  let i = gitAt + 1;
  /* git's own options before the subcommand: `git -C dir checkout …` */
  while (i < words.length && words[i].startsWith("-")) {
    if (VALUED.has(words[i])) i += 1;
    i += 1;
  }
  const sub = words[i];
  if (sub !== "checkout" && sub !== "restore") return null;

  const rest = words.slice(i + 1);
  const dashDash = rest.indexOf("--");
  const flags = (dashDash < 0 ? rest : rest.slice(0, dashDash)).filter((w) => w.startsWith("-"));

  /* AN INDEX-ONLY RESTORE TOUCHES NO WORKING-TREE FILE, so it is not
     this guard's business: `git restore --staged x` unstages and
     leaves the file on disk exactly as it is. With `--worktree` too,
     it is destructive again. */
  if (sub === "restore" && flags.includes("--staged") && !flags.includes("--worktree")) {
    return { sub, paths: [], why: "index-only restore" };
  }

  /* CONFLICT RESOLUTION IS ALLOWED. During a merge the "dirty" state
     IS the conflict, and picking a side is the whole point. */
  if (flags.includes("--ours") || flags.includes("--theirs")) {
    return { sub, paths: [], why: "conflict resolution" };
  }

  if (dashDash >= 0) {
    /* EXPLICIT: everything after `--` is a pathspec, by git's own
       rule. No guessing required. */
    return { sub, paths: rest.slice(dashDash + 1).filter(Boolean), why: "explicit pathspec" };
  }

  /* No separator, so each bare word is a ref or a path and git itself
     decides by asking the same two questions. */
  const bare = [];
  for (let k = 0; k < rest.length; k += 1) {
    const w = rest[k];
    if (w.startsWith("-")) {
      if (VALUED.has(w)) k += 1;
      continue;
    }
    bare.push(w);
  }

  if (sub === "checkout") {
    /* A branch switch, a new branch, a detached checkout: nothing in
       the working tree is overwritten by path. Only a word that is NOT
       a ref and IS a path can be a pathspec. */
    return { sub, paths: bare.filter((w) => !isRef(w) && isPath(w)), why: "inferred pathspec" };
  }
  /* `git restore` has no branch-switch form — every bare word is a
     path. */
  return { sub, paths: bare.filter((w) => isPath(w)), why: "restore pathspec" };
}

/**
 * The directory a `cd` leaves the rest of the command in.
 *
 * Only a plain literal counts. `cd "$DIR"` resolves to the empty string
 * once the quotes come off, and `cd -` is not a directory — both return
 * null, which leaves the previous directory in place and makes the
 * pathspec resolve to something that is not a tracked file, which
 * ALLOWS. That is the fail-open direction, deliberately.
 */
export function readCd(segment) {
  const words = tokenise(segment);
  if (words[0] !== "cd" || words.length !== 2) return null;
  const target = words[1];
  if (!target || target === "-" || target.startsWith("$")) return null;
  return target;
}

/* ---------- the repository questions ---------- */

const git = (args, cwd = repoRoot()) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const refExists = (w) => {
  try {
    git(["rev-parse", "--verify", "--quiet", `${w}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

const pathExists = (w) => {
  try {
    return git(["ls-files", "--error-unmatch", "--", w]).trim().length > 0;
  } catch {
    return false;
  }
};

/**
 * Tracked files under `spec` with uncommitted changes.
 *
 * BOTH COLUMNS COUNT. `git checkout -- <file>` copies from the index,
 * so it destroys unstaged work; `git checkout <commit> -- <file>` and
 * `git restore --staged --worktree` destroy staged work as well. One
 * check covering both is the conservative reading, and this is a guard
 * against losing something rather than a model of git's semantics.
 *
 * UNTRACKED FILES ARE NOT COUNTED: neither command removes them.
 */
export function dirtyUnder(spec, run = (s) => git(["status", "--porcelain", "--", s])) {
  let out = "";
  try {
    out = run(spec);
  } catch {
    return [];
  }
  return out
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.startsWith("??"))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/* ---------- the verdict ---------- */

export function decide(command, io = {}) {
  const isRef = io.isRef || refExists;
  const isPath = io.isPath || pathExists;
  const dirty = io.dirty || ((s) => dirtyUnder(s));
  const root = io.root || repoRoot();

  /* A pathspec is relative to where the command runs, so a `cd`
     earlier in the same Bash invocation moves it. Resolved to an
     absolute path, which git accepts as a pathspec inside the repo and
     rejects outside it — and a rejection is caught and reads as
     "nothing dirty", which allows. */
  let cwd = root;
  for (const segment of segments(command)) {
    const cd = readCd(segment);
    if (cd) {
      cwd = path.resolve(cwd, cd);
      continue;
    }
    const at = (spec) => path.resolve(cwd, spec);
    const parsed = readGitCommand(segment, { isRef, isPath: (w) => isPath(at(w)) });
    if (!parsed || parsed.paths.length === 0) continue;
    for (const spec of parsed.paths) {
      const files = dirty(at(spec));
      if (files.length) return { block: true, sub: parsed.sub, spec, files };
    }
  }
  return { block: false };
}

export function reasonFor({ sub, spec, files }) {
  const list = files.slice(0, 5).join(", ") + (files.length > 5 ? `, and ${files.length - 5} more` : "");
  return (
    `REFUSED: \`git ${sub}\` against "${spec}", which has uncommitted changes — ${list}.\n\n` +
    `\`git ${sub}\` reverts to the last COMMIT, not to what the working tree held a moment ago. ` +
    `If those changes are a deliberate mutation you are undoing, they are also everything else uncommitted in that file, ` +
    `and it will come back building and plausible with nothing to say it lost anything.\n\n` +
    `Do one of these instead:\n` +
    `  • copy the file aside FIRST, then restore from the copy — the rule in CLAUDE.md, and the only one that works mid-mutation\n` +
    `  • \`git stash push -- ${spec}\` — same effect, and recoverable with \`git stash pop\`\n` +
    `  • commit the real work first, then revert freely\n\n` +
    `If this refusal is wrong, the guard is .claude/hooks/guard-dirty-checkout.mjs and it is disabled by removing the hook from .claude/settings.json.`
  );
}

/* ---------- the hook entry point ---------- */

const allow = () => process.exit(0);

async function main() {
  let payload = "";
  for await (const chunk of process.stdin) payload += chunk;

  let command = "";
  try {
    command = JSON.parse(payload)?.tool_input?.command || "";
  } catch {
    return allow();
  }
  if (!command) return allow();

  let verdict;
  try {
    verdict = decide(command);
  } catch {
    /* FAIL OPEN. See the header: a guard that breaks and blocks
       everything is a guard somebody switches off. */
    return allow();
  }
  if (!verdict.block) return allow();

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reasonFor(verdict),
      },
    })
  );
  process.exit(0);
}

/* Only when run as the hook, so a test can import the decision
   functions without the script waiting on stdin for ever. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
