/* ==================================================================
   build-facts.js — the handful of facts the page needs that live in
   OTHER files, written here by the build

   NOT HAND-MAINTAINED. scripts/build-web.mjs regenerates this from
   desktop/package.json every time it runs, so the repository URL, the
   product name and the three artifactName templates cannot drift from
   what electron-builder will actually produce. A test asserts the
   generated file matches the source it was generated from.

   The alternative was importing desktop/package.json from the browser
   bundle, which does not work, or typing the four values into the page,
   which is the restatement this project spends most of its discipline
   avoiding.
   ================================================================== */

export const REPOSITORY_URL = "https://github.com/jjwesterlaken/UniPlanner.git";
export const PRODUCT_NAME = "University Planner";
export const ARTIFACT_NAMES = {
  "nsis": "${productName} Setup.${ext}",
  "portable": "${productName} Portable.${ext}",
  "linux": "${productName}.${ext}"
};

/* Where the planner lives — ABSOLUTE, and written by the build from
   SITE_URL rather than typed here.

   It was "/app", which was wrong twice: the app is still served from
   the root, so the hero button 404s today; and root-relative breaks
   entirely when this page is served from the APEX domain, which is a
   different host. */
export const APP_URL = "https://www.uniplannerapp.com";
