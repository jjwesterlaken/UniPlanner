/* Runs once before the journeys: decide whether they can run at all,
   then reset the test account to the seed.

   Missing credentials: SKIP locally (a developer without the secrets
   should still be able to run everything else), FAIL in CI
   (REQUIRE_E2E=1) — a journey that quietly stops running is how the
   next eleven-day bug ships. The skip is written to state.json and
   read by the spec, so the decision is made in exactly one place. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { haveCreds, REQUIRED, resetAccount } from "./helpers.mjs";

const stateFile = path.join(path.dirname(fileURLToPath(import.meta.url)), ".state.json");

export default async function globalSetup() {
  if (!haveCreds()) {
    if (REQUIRED) {
      throw new Error(
        "REQUIRE_E2E=1 but TEST_ACCOUNT_EMAIL / TEST_ACCOUNT_PASSWORD are not set. " +
          "In CI these come from the repository secrets of the same names — create the dedicated test account " +
          "(sign up in the app, confirm the email) and add both secrets."
      );
    }
    fs.writeFileSync(stateFile, JSON.stringify({ skip: "no test-account credentials; set TEST_ACCOUNT_EMAIL / TEST_ACCOUNT_PASSWORD" }));
    return;
  }
  const { seed, userId } = await resetAccount();
  fs.writeFileSync(stateFile, JSON.stringify({ seed, userId }));
}
