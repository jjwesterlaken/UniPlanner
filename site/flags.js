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

  /** App Store badge. ON when the listing is live. iOS has never been
      compiled to a device, so this is further out than Play. */
  appStoreBadge: false,

  /** The macOS download. ON when the build is signed and notarised —
      NOT when a .dmg exists, because one already does. Unsigned, macOS
      refuses to open it rather than warning. */
  macDownload: false,

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
