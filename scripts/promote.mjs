/* npm run promote — ship main to production, deliberately.

   Under promote-on-release (CLAUDE.md, Hosting), merging to main
   builds a PREVIEW; production only moves when main is promoted into
   the `release` branch. This script IS the ritual, so it cannot be
   forgotten in a merged PR body: it shows what would ship, pushes the
   fast-forward, and prints the verification.

   A fast-forward is the whole contract: `release` stays a strict
   prefix of `main`, so the commits that reach users are byte-for-byte
   the commits the preview verified. If the push refuses, someone has
   pushed to release directly — stop and look, don't force. */

import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

git("fetch", "origin", "main", "release");

const pending = git("log", "--oneline", "origin/release..origin/main");
if (!pending) {
  console.log("Nothing to promote: release already matches main.");
  process.exit(0);
}

console.log("About to promote to PRODUCTION (www.uniplannerapp.com):\n");
console.log(pending.split("\n").map((l) => `  ${l}`).join("\n"));
console.log("");

try {
  // Plain push, not --force: only a fast-forward can succeed, which is
  // exactly the guarantee the ritual depends on.
  execFileSync("git", ["push", "origin", "origin/main:release"], { stdio: "inherit" });
} catch (e) {
  console.error("\nPromote refused. If the error above says non-fast-forward, someone pushed");
  console.error("to release directly — reconcile that before promoting; never force.");
  process.exit(1);
}

console.log("\nPromoted. Verify (allow a minute or two for the Pages build):");
console.log("  curl -s https://www.uniplannerapp.com/sw.js | grep 'const CACHE'");
console.log("The build id must match the main preview's id and the Account tab.");
console.log("(A docs-only promote legitimately leaves the build id unchanged.)");
