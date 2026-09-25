/* ==================================================================
   feedbackLink.js — where the "tell us" link on the Account tab goes,
   and what it says. Pure: the platform is an argument, so the whole
   matrix is a table in scripts/test-feedback-link.mjs rather than
   something only a handset can answer.

   TWO DESTINATIONS, CHOSEN BY WHAT THE SHELL CAN OPEN.

   - iOS native: a `mailto:` with the version and platform already in
     it. Capacitor 8's `WebViewDelegationHandler` hands any top-level
     navigation outside the app to `UIApplication.shared.open`, so the
     link opens the student's mail app. If they have deleted Mail and set
     no other default, iOS offers to restore Mail, so the link still
     does something.
   - Everywhere else: the support page. A browser or the desktop shell
     may have no mail client configured, and a `mailto:` there is the
     link that silently does nothing. So the page carries the address
     and the student quotes the version themselves. Android stays on
     the page as well: its shell fires an ACTION_VIEW intent, and with
     no app that handles `mailto:` that fails with only a log line.
     Moving Android to mail is a decision for a device, not for this
     file.

   #115's comment said a `mailto:` "is not reliably handled inside a
   Capacitor WebView". That is not true of iOS on the version we ship,
   and the navigation handler above is the evidence.

   NOTHING LEAVES THE DEVICE UNTIL THE STUDENT SENDS IT. The pre-filled
   body is two facts, the build id and the platform, and nothing else:
   no account, no planner, no device model. The student sees both in
   their own mail app before anything is sent.

   The copy lives here so Grace can reword it without touching a
   component. It asks for feedback as well as faults, because a link
   worded only for faults gets only faults.
   ================================================================== */

/** The line's wording, one place. */
export const FEEDBACK_COPY = Object.freeze({
  prompt: "Found a problem, or have an idea?",
  action: "Tell us",
  /* Only on the page route: there the student has to carry the
     version across by hand. The mail route already carries it, and
     asking for it again there would be noise. */
  quoteVersion: "quote the version above.",
});

const PLATFORM_NAMES = Object.freeze({ ios: "iOS", android: "Android", web: "Web" });

/** A readable platform name; unknown shapes read as their raw value, never a guess. */
export function platformName(platform) {
  return PLATFORM_NAMES[platform] || String(platform || "unknown");
}

/**
 * Where the link goes, and whether the version still has to be quoted.
 *
 * @returns {{ kind: "mail" | "page", href: string, quoteVersion: boolean }}
 */
export function feedbackLink({ isNative, platform, build, supportUrl, supportEmail }) {
  if (isNative === true && platform === "ios") {
    const name = platformName(platform);
    const subject = `UniPlanner feedback (${build}, ${name})`;
    const body = ["", "", "", "---", `Version: ${build}`, `Platform: ${name}`].join("\n");
    return {
      kind: "mail",
      href: `mailto:${supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
      quoteVersion: false,
    };
  }
  return { kind: "page", href: supportUrl, quoteVersion: true };
}
