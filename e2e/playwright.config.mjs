/* Playwright config for the three journeys.

   Everything here optimises for ONE property: a failing run must say
   which journey, which step, and what the screen looked like — not a
   wall of trace. So: the list reporter names each test.step as it
   passes; screenshots and traces are kept ONLY for failures, uploaded
   as CI artifacts rather than printed; one worker, serial, because the
   journeys share one real account and an ordering (3 archives what 1
   and 2 created).

   The journeys run against the BUILT app (dist-web via e2e/serve.mjs)
   talking to the LIVE Supabase project with a dedicated test account.
   No mock: every production bug this project has had passed the full
   jsdom suite and could not have survived one real browser against
   the real database. */

import { defineConfig } from "@playwright/test";

const CI = !!process.env.CI;

export default defineConfig({
  testDir: ".",
  testMatch: "journeys.spec.mjs",
  globalSetup: "./global-setup.mjs",
  timeout: 150_000, // real network: sign-in, a 4s push debounce, a sync-triggered migration
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: CI ? 1 : 0, // one retry in CI: the network is real, so one blip is not a finding
  reporter: [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: `http://127.0.0.1:${process.env.E2E_PORT || 4173}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // For environments with a pre-installed Chromium at a fixed path
    // (containers that block the download). CI ignores this: the
    // workflow installs the matching browser instead.
    ...(process.env.E2E_CHROMIUM ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM } } : {}),
  },
  webServer: {
    command: "node e2e/serve.mjs",
    cwd: "..",
    url: `http://127.0.0.1:${process.env.E2E_PORT || 4173}/index.html`,
    reuseExistingServer: !CI,
    timeout: 30_000,
  },
});
