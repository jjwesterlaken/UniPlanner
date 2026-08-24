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

  /** Real prices. ON when Gate 1 lands and the tier prices are decided.
      Until then the pricing table renders its placeholder treatment. */
  prices: false,
};
