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

/* The only cross-module read in this file, and it is a fact about the
   world rather than about downloads: whether the Mac build is signed
   and notarised yet. */
import { FLAGS } from "./flags.js";


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
 *
 * `${name}` USED TO BE RESOLVED HERE, TO `productName`, WHICH IS WRONG:
 * electron-builder's `${name}` is the package `name` field
 * ("university-planner"), not the product name. A template using it
 * would have produced a link to a file that was never built. It is left
 * unresolved on purpose, so the check below refuses it loudly instead —
 * "no" and "nothing" have to be different answers.
 */
export function assetName(template, { productName, ext }) {
  const filled = String(template)
    .replaceAll("${productName}", productName)
    .replaceAll("${ext}", ext);
  if (/\$\{/.test(filled)) {
    throw new Error(
      `artifactName "${template}" still contains a substitution after filling: ${filled}. ` +
        "A download link cannot be built from a name that varies by release — see the header of site/downloads.js."
    );
  }
  /* A BACKSTOP, AND IT USED TO BE THE WHOLE MECHANISM. electron-builder
     writes the file with whatever the template says — spaces included —
     and GITHUB is what replaces a space with a dot when the asset is
     uploaded. So `University Planner.dmg` on the runner became
     `University.Planner.dmg` on the release and this line was what kept
     the link working.

     What it could not fix is the half nothing here reads: the
     `latest*.yml` electron-builder writes beside the installers spell
     the same space as a HYPHEN, so the update manifests named
     `University-Planner.dmg` while the release carried
     `University.Planner.dmg` — three spellings of one file, two of them
     404. The artifactName templates carry no spaces now, which makes
     all three agree by construction; this stays as the backstop for a
     template that grows one again, and `scripts/test-site.mjs` asserts
     none does. */
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
      note: FLAGS.windowsUnsignedNote
        ? "Windows may show a security warning on first install — click More info, then Run anyway."
        : null,
      available: true,
    },
    {
      id: "mac",
      /* "Mac" rather than "macOS" (Jared, 16 September 2026). It is
         what the platform is called on a download button, and it is
         the name the RENDERER uses too — site.js takes the card
         heading from this field rather than keeping its own copy, so
         the two cannot come to disagree about what the platform is
         called. The blurb and the words on the button stay Grace's. */
      label: "Mac",
      /* THE ONE CARD THAT READS A FLAG, because it is the one whose
         availability depends on something outside this repository.

         The others are available the moment a release exists. This one
         needed a Developer ID certificate, a notarisation submission and
         an Apple account behind both — and until those landed a .dmg
         existed and was unshippable: unsigned and un-notarised, macOS
         does not warn, it REFUSES, with a dialogue saying the app is
         damaged. That is why Windows got a note and this got "coming
         soon"; an unsigned Windows build is a scary sentence, an
         unsigned Mac build is a dead end.

         FLAGS.macDownload is what turns it on, and its own comment
         carries the condition. `scripts/test-site.mjs` refuses to let
         that flag be true unless the pipeline that signs and CHECKS the
         build is really in the workflow — so this link cannot be
         switched on by editing a boolean. */
      href: FLAGS.macDownload ? downloadUrl(slug, assets.macDmg) : null,
      /* THE INSTALL NOTE, and it is here for the same reason the
         Windows one is: it belongs with the button, and it comes off in
         one edit. A .dmg is a disk image rather than an installer, and
         a student who opens it, double-clicks the app INSIDE it and
         gets a working planner has in fact installed nothing — the app
         is running out of a mounted image that vanishes on eject, and
         takes the shortcut they made with it. */
      note: FLAGS.macDownload
        ? "Open the downloaded file and drag University Planner into the Applications folder shown, then launch it from Applications."
        : null,
      available: FLAGS.macDownload,
      soon: FLAGS.macDownload ? null : "Coming soon",
      /* WHAT TO DO INSTEAD, and it is on the CARD so it cannot outlive
         the card's own availability. A hand-written paragraph under the
         download box said "a desktop build exists but is not signed by
         Apple yet -- use the web app in the meantime", and it was still
         there beside a working, signed, notarised .dmg: the same defect
         as the dead "null" button, in prose rather than in a renderer,
         and for the same reason -- a sentence about a flag, written
         somewhere the flag is not read.

         `downloadsFor` returns it only for a card that is NOT
         available, so it is unreachable while there is a download. */
      instead: FLAGS.macDownload ? null : "A Mac build is coming. The web app works in the meantime.",
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
    /* THE NOTE UNDER THE BOX, DERIVED FROM THE CARDS THEMSELVES. It is
       an array so an empty one renders nothing, and it can only ever
       describe a platform whose card is unavailable — which is what
       makes "the Mac note beside the Mac download" unreachable rather
       than merely fixed. */
    unavailable: cards.filter((c) => !c.available && c.instead).map((c) => ({ label: c.label, instead: c.instead })),
    allReleases: releasesUrl(slug),
  };
}
