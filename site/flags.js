/* ==================================================================
   flags.js — what is visible on the marketing site, and why it is not

   ONE FILE, SO "IS THE STORE LISTING LIVE YET" IS ONE EDIT. Each flag
   is off, and each carries the CONDITION that turns it on rather than a
   date — a date goes stale and gets ignored, a condition can be
   checked.

   A HIDDEN BADGE IS NOT A BROKEN ONE. The slots exist in the markup and
   are hidden by these flags, so turning one on is a boolean rather than
   a layout change under time pressure on the day a listing goes live.
   ================================================================== */

export const FLAGS = {
  /** Google Play badge. ON when the listing is live — which is after
      the closed test's 12 testers / 14 continuous days and up to a
      further week for production access. */
  playBadge: false,

  /** App Store badge. ON when the listing is live.

      ON since 24 September 2026. iOS 1.1.0 is approved and live
      (build 3523413) and the listing is at APP_STORE_URL in
      site/store-listing.js, which is where the href comes from.

      THIS BOOLEAN IS NO LONGER THE WHOLE DECISION, and that is
      deliberate: `fillStoreBadges` requires the flag AND a URL, so
      flipping one without the other renders "Coming soon" rather than
      a badge that says "Get it now" and links nowhere. The version of
      this comment that stood here described exactly that hazard, and
      the remedy was to make it unreachable instead of remembered.

      An earlier version said iOS had never been compiled. It had. */
  appStoreBadge: true,

  /** The macOS download. ON since Developer ID signing and notarisation
      were wired into build-apps.yml — which is the condition this flag
      always carried, and NOT "a .dmg exists", because one already did
      and it was unshippable.

      IT IS NOT A BOOLEAN ANYBODY MAY FLIP. `scripts/test-site.mjs`
      refuses this being true unless the workflow really signs, really
      notarises and really runs Gatekeeper's own assessment against the
      built bundle — because the failure it guards is silent: an
      unsigned .dmg uploads, publishes and looks normal, then refuses to
      open on the student's Mac saying the app is damaged, which reads
      as a corrupt download.

      THE ORDERING THIS DOES NOT ENFORCE, and it is the one to know: the
      link resolves to `latest`, so between this merging and the first
      SIGNED release being cut it would hand somebody the previous,
      unsigned build. Nothing static can know which release was signed.
      So the site must not be promoted to production until that release
      exists — DEPLOY-CHECKLIST §7a. */
  macDownload: true,

  /** The Windows unsigned-install note under the download button. OFF
      when code signing is arranged, which removes the SmartScreen
      warning it explains. */
  windowsUnsignedNote: true,

  /** Real prices. ON since Phase 0 of the 1.1.0 billing work, when
      Jared set the six figures in pricing.js.

      GATE 1 WAS CONSCIOUSLY DEFERRED, not passed. It is COST-MODEL.md
      12.7's photo-token measurement, and the reason it gated a price
      at all is that a photographed reading is the most expensive
      action in the app on the model we run and among the cheapest on
      the one recommended — so a price per credit set before that
      ratio is known is set against a cost known to be wrong. The
      decision was to ship prices anyway and treat the photo path as
      held (PHOTO_BATCH_CREDITS, pinned by a test) until the model
      move lands. Recorded here and in COST-MODEL.md 12.8 so that
      "the prices are live" is never mistaken for "the measurement
      was taken". */
  prices: true,
};
