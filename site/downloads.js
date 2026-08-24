/* ==================================================================
   downloads.js — where the desktop builds come from, and which one to
   lead with

   TWO RULES SHAPE EVERY LINE OF THIS FILE.

   1. NO RELEASE URL IS WRITTEN DOWN. Not the version, not the tag, not
      the asset path. GitHub resolves `/releases/latest/download/<name>`
      server-side at CLICK time, so a new release is picked up with no
      rebuild, no constant to bump and nothing to strand. The owner and
      repo come from desktop/package.json's `repository` field — which
      electron-builder REQUIRES, so it cannot quietly disappear — and
      the asset names come from that same file's artifactName
      templates. Nothing here restates either.

   2. NO REQUEST IS MADE. The obvious alternative is fetching
      api.github.com for the latest release, and it would work — but it
      is a third-party request from the visitor's browser, and the
      marketing site holds the same zero-third-party-requests promise
      the app does. An `href` is not a request until somebody clicks
      it, which is the whole reason `latest/download` is the right
      mechanism rather than a convenience.

   THE PRICE OF (1), STATED SO NOBODY IS SURPRISED: `latest/download`
   needs the asset NAME to be stable across releases. electron-builder
   defaults to putting ${version} in it, which makes every name a
   moving target — so the artifactName templates were changed to drop
   it. A release published before that change has version-ed names and
   these links will 404 against it. See SITE-DEPLOY.md.
   ================================================================== */

/**
 * Parse `owner/repo` out of a git remote URL.
 *
 * Handles the https and ssh spellings because the `repository` field is
 * hand-written and both are legal there.
 */
export function repoSlug(repositoryUrl) {
  const m = String(repositoryUrl || "").match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

/**
 * The asset name electron-builder will produce for a target.
 *
 * `template` is the artifactName string from desktop/package.json —
 * `${productName}`, `${version}`, `${ext}` and friends. Only the
 * substitutions we can resolve offline are made; a template still
 * containing `${version}` after substitution is REJECTED rather than
 * guessed at, because a name with a version in it cannot be linked to
 * with `latest/download` and silently 404s.
 */
export function assetName(template, { productName, ext }) {
  const filled = String(template)
    .replaceAll("${productName}", productName)
    .replaceAll("${name}", productName)
    .replaceAll("${ext}", ext);
  if (/\$\{/.test(filled)) {
    throw new Error(
      `artifactName "${template}" still contains a substitution after filling: ${filled}. ` +
        "A download link cannot be built from a name that varies by release — see the header of site/downloads.js."
    );
  }
  /* electron-builder replaces spaces with dots in the file it writes,
     and GitHub serves the asset under the name it was uploaded with. */
  return filled.replace(/ /g, ".");
}

/** The permanent link to a named asset of whatever the latest release is. */
export const downloadUrl = ({ owner, repo }, name) =>
  `https://github.com/${owner}/${repo}/releases/latest/download/${encodeURIComponent(name)}`;

/** Where "see all builds" goes. Also never version-specific. */
export const releasesUrl = ({ owner, repo }) => `https://github.com/${owner}/${repo}/releases/latest`;

/* ---------- which one to lead with ---------- */

export const PLATFORMS = ["windows", "mac", "linux", "android", "ios", "other"];

/**
 * The visitor's platform, from what a browser will actually tell us.
 *
 * PURE, and takes the environment as an argument, so the whole matrix
 * is a table in a test rather than something only a real browser can
 * answer — the same arrangement as src/audioSources.js, and for the
 * same reason.
 *
 * `userAgentData.platform` is preferred where it exists because it is
 * the one field Chrome has not frozen into a lie; the UA string is the
 * fallback and is read in the order that matters. iPadOS is the case
 * that catches people: it reports itself as a Mac, and is told apart
 * only by having a touchscreen.
 */
export function detectPlatform({ userAgent = "", platformHint = "", maxTouchPoints = 0 } = {}) {
  const hint = String(platformHint).toLowerCase();
  const ua = String(userAgent).toLowerCase();

  if (hint.includes("win") || /windows|win32|win64/.test(ua)) return "windows";
  if (/android/.test(ua)) return "android";
  /* Before the Mac checks: an iPad says "Macintosh" and means it,
     right up until you notice it has ten touch points. */
  if (/iphone|ipod/.test(ua)) return "ios";
  if (/ipad/.test(ua)) return "ios";
  if ((hint.includes("mac") || /macintosh|mac os x/.test(ua)) && maxTouchPoints > 1) return "ios";
  if (hint.includes("mac") || /macintosh|mac os x/.test(ua)) return "mac";
  /* Chrome OS before Linux: every Chromebook UA also says "Linux", and
     an AppImage is not what a Chromebook wants. */
  if (/cros/.test(ua)) return "other";
  if (hint.includes("linux") || /linux|x11/.test(ua)) return "linux";
  return "other";
}

/**
 * The download cards, in the order to show them.
 *
 * EVERY PLATFORM IS ALWAYS RETURNED. Leading with the visitor's is a
 * convenience; hiding the others is a trap, because the person choosing
 * a download is often not on the machine they are downloading for — a
 * student on a phone picking up the Windows build for their laptop is
 * the ordinary case, not the exotic one.
 */
export function downloadsFor(platform, { slug, assets }) {
  const cards = [
    {
      id: "windows",
      label: "Windows",
      href: downloadUrl(slug, assets.windowsInstaller),
      alt: { label: "Portable version (no installer)", href: downloadUrl(slug, assets.windowsPortable) },
      /* THE SECURITY WARNING NOTE. It is here rather than in the page
         because it must appear with the button and nowhere else, and
         because it comes off in one edit when signing is arranged --
         see SITE-DEPLOY.md. A student who hits SmartScreen with no
         warning that it was coming assumes the download is malware,
         which is the correct instinct and the wrong conclusion. */
      note: "Windows may show a security warning on first install — click More info, then Run anyway.",
      available: true,
    },
    {
      id: "mac",
      label: "macOS",
      href: null,
      note: null,
      available: false,
      /* NOT "we haven't built it". A Mac build exists and is published.
         Unsigned and un-notarised, macOS does not warn — it refuses,
         with a dialogue saying the app is damaged. That is unshippable
         in a way an unsigned Windows build is not, which is why one
         gets a note and the other gets "coming soon". */
      soon: "Coming soon",
    },
    {
      id: "linux",
      label: "Linux",
      href: downloadUrl(slug, assets.linuxAppImage),
      note: "An AppImage — make it executable and run it, no install needed.",
      available: true,
    },
  ];
  const lead = platform === "mac" || platform === "ios" ? "mac" : platform === "linux" ? "linux" : "windows";
  return {
    lead,
    /* Sorted, not filtered. */
    cards: [...cards].sort((a, b) => (a.id === lead ? -1 : b.id === lead ? 1 : 0)),
    allReleases: releasesUrl(slug),
  };
}
