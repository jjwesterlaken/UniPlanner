/* ==================================================================
   plans.jsx — the Plans panel on the Account tab

   FUNCTIONAL AND PLAIN, on purpose (Jared, Phase 2). Grace restyles it
   later; nothing here is a design decision beyond reusing the classes
   the rest of the app already has. What it must be is COMPLETE, because
   an App Store reviewer checks a subscription screen by looking at it:
   the price, the period, that it renews automatically, how to cancel, a
   visible Restore control, and links to the terms and the privacy
   policy. Those are Apple's requirements rather than ours, and a
   missing one is a rejection rather than a bug report.

   THE TIER COMES FROM `profiles`, NEVER FROM THE STORE SDK. The webhook
   is the only writer, so the client's job is to read what it wrote —
   which is also why this panel works, read-only, on web and desktop
   where nothing can be bought. The SDK's `customerInfo` is consulted
   for exactly one thing: the account-specific "manage subscription"
   link, which is a URL and not an entitlement.

   AND THE GAP IT HAS TO COVER: a purchase completes on the device
   BEFORE our server hears about it. `refreshEntitlementSoon` re-reads
   on a short bounded ladder and the copy says "activating" in the
   meantime, because a panel that still said Free to somebody who had
   just paid would read as a purchase that failed.
   ================================================================== */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CreditCard, ExternalLink, RefreshCw } from "lucide-react";
import { fetchUsage } from "./aiNotesClient.js";
import { DURATION_ORDER, SELLABLE_TIERS, groupPackages, manageSubscriptionUrl } from "./purchasePlans.js";
import { purchaseCapability, loadPackages, purchasePackage, restorePurchases } from "./purchases.js";
import {
  ACTIONS,
  ACTIVATING_NOTICE,
  DISCLOSURES,
  LINKS,
  PANEL_TITLE,
  WEB,
  buyLabel,
  termsLink,
  currentPlanLine,
  outcomeMessage,
  resetLine,
  unavailableLine,
  webFailureMessage,
} from "./plansCopy.js";
import { bumpEntitlement, entitlementVersion, refreshEntitlementSoon, subscribeEntitlement } from "./entitlementRefresh.js";
import { STRIPE_ENABLED, WEB_PLANS } from "./billingFlags.js";
import { openPortal, startCheckout } from "./stripeClient.js";
import { webPriceLabel } from "./webPrices.js";
import { btnPrimary, btnGhost, Card } from "./PlannerApp.jsx";

/**
 * The shared "ask the server again" signal.
 *
 * Every reader of `profiles.tier` uses this same hook, so a purchase on
 * this panel moves the AI allowance badge on a tab that is not even
 * mounted right now — which is the whole point of it being a module
 * -level store rather than component state.
 */
export const useEntitlementVersion = () => useSyncExternalStore(subscribeEntitlement, entitlementVersion, entitlementVersion);

export function PlansPanel({ session }) {
  const version = useEntitlementVersion();
  const [tier, setTier] = useState(null);
  /* WHERE the plan came from, so "manage" points at the right place —
     Stripe's Customer Portal and a store's own page are different
     destinations and sending somebody to the wrong one is a dead end. */
  const [store, setStore] = useState(null);
  const [packages, setPackages] = useState([]);
  const [customerInfo, setCustomerInfo] = useState(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState(null);
  const [activating, setActivating] = useState(false);
  const cancelPoll = useRef(null);

  /* Read once per mount and again on every bump. `unavailable` is kept
     as null rather than coerced to "free": the copy has a sentence for
     "we could not check" and it is not the same sentence as "you are on
     the free plan". */
  useEffect(() => {
    let cancelled = false;
    fetchUsage(session).then((u) => {
      if (cancelled) return;
      setTier(u && !u.unavailable ? u.tier : null);
      setStore(u && !u.unavailable ? u.store || null : null);
    });
    return () => {
      cancelled = true;
    };
  }, [session && session.user && session.user.id, version]);

  const capability = purchaseCapability();

  useEffect(() => {
    if (!capability.available || !session) return undefined;
    let cancelled = false;
    loadPackages().then((r) => {
      if (!cancelled && r.ok) setPackages(r.packages);
    });
    return () => {
      cancelled = true;
    };
  }, [capability.available, session && session.user && session.user.id]);

  /* Timers outlive a tab change, and a bump fired into an unmounted
     component is how a React warning becomes something people ignore. */
  useEffect(() => () => cancelPoll.current && cancelPoll.current(), []);

  const startPolling = useCallback(() => {
    setActivating(true);
    if (cancelPoll.current) cancelPoll.current();
    cancelPoll.current = refreshEntitlementSoon();
  }, []);

  const buy = async (pkg) => {
    setBusy(pkg.identifier);
    setMessage(null);
    const result = await purchasePackage(pkg);
    setBusy("");
    setMessage(outcomeMessage("purchase", result.ok ? null : result.reason));
    if (result.ok) {
      setCustomerInfo(result.customerInfo || null);
      startPolling();
    }
  };

  const restore = async () => {
    setBusy("restore");
    setMessage(null);
    const result = await restorePurchases();
    setBusy("");
    setMessage(outcomeMessage("restore", result.ok ? null : result.reason));
    if (result.ok) {
      setCustomerInfo(result.customerInfo || null);
      startPolling();
    }
  };

  /* WEB PURCHASES ARE OFF UNTIL THE FLAG SAYS OTHERWISE. Three
     conditions, and each is doing work: the flag (a reviewable commit,
     not a dashboard toggle), a session (the uid comes from the JWT and
     there is no anonymous purchase), and `reason === "web"` — because a
     phone with no RevenueCat key is ALSO `!capability.available`, and
     offering it a card payment instead of fixing the build would be the
     wrong answer to the wrong question. */
  const webPurchases = STRIPE_ENABLED && !capability.available && capability.reason === "web" && !!session;

  /* Derived from the same six plans the phones sell, so the web cannot
     silently be missing one — grouped here rather than in a constant
     because the shape the buttons want is tier-then-duration. */
  const webGroups = SELLABLE_TIERS.map((t) => ({
    tier: t,
    durations: DURATION_ORDER.filter((d) =>
      Object.values(WEB_PLANS).some((plan) => plan.tier === t && plan.duration === d)
    ),
  })).filter((g) => g.durations.length > 0);

  const token = session && session.access_token;

  const buyOnWeb = async (t, duration) => {
    setBusy(`${t}-${duration}`);
    setMessage(null);
    try {
      const { url } = await startCheckout({ token, tier: t, duration });
      /* A NEW TAB, not a redirect. On the web it keeps the planner
         where it was; on the desktop build it is what makes Electron
         hand the link to the system browser rather than opening
         Stripe inside the app window. */
      window.open(url, "_blank", "noopener,noreferrer");
      /* The webhook writes the tier once the payment completes, which
         is not now — so the same bounded ladder the store path uses
         picks it up when the student comes back. */
      startPolling();
    } catch (err) {
      setMessage(webFailureMessage(err && err.code, err && err.store));
    } finally {
      setBusy("");
    }
  };

  const manageOnWeb = async () => {
    setBusy("manage");
    setMessage(null);
    try {
      const { url } = await openPortal({ token });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setMessage(webFailureMessage(err && err.code, err && err.store));
    } finally {
      setBusy("");
    }
  };

  const grouped = groupPackages(packages);
  const manageUrl = manageSubscriptionUrl({ customerInfo, store: capability.store });
  const unavailable = unavailableLine(capability.reason);
  const terms = termsLink(capability.reason);

  return (
    <Card>
      <div className="flex items-center gap-2">
        <CreditCard size={17} className="u-accent-text" />
        <h3 className="text-sm font-semibold text-stone-800">{PANEL_TITLE}</h3>
      </div>

      <p className="mt-2 text-sm text-stone-700" data-plan-line>
        {currentPlanLine(tier)}
      </p>
      {tier && <p className="mt-1 text-xs text-stone-500">{resetLine(tier)}</p>}
      {activating && <p className="mt-1 text-xs text-stone-500">{ACTIVATING_NOTICE}</p>}
      {message && <p className="mt-2 rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-700">{message}</p>}

      {/* THE PURCHASE HALF, native only. On web and desktop there is one
          sentence saying where plans are bought and nothing else — not a
          "coming soon", which would promise a surface this one is never
          going to have. */}
      {!capability.available && webPurchases ? (
        /* PHASE 6, BEHIND STRIPE_ENABLED. The same panel, a different
           payment provider: the web cannot reach a store, so a card
           payment through Stripe Checkout is the only way it can sell
           anything at all. The button opens Stripe's own hosted page —
           in a new tab on the web, and in the system browser on the
           desktop build, which already refuses to open an http link
           in-app (desktop/main.js) and hands it to the OS. */
        <div className="mt-4 space-y-4" data-web-purchase>
          {webGroups.map((group) => (
            <div key={group.tier} className="space-y-1.5">
              {group.durations.map((duration) => (
                <button
                  key={`${group.tier}-${duration}`}
                  type="button"
                  className={`${btnPrimary} w-full`}
                  disabled={!!busy}
                  onClick={() => buyOnWeb(group.tier, duration)}
                  data-web-plan={`${group.tier}-${duration}`}
                >
                  {buyLabel(group.tier, duration, webPriceLabel(group.tier, duration))}
                </button>
              ))}
            </div>
          ))}
          <p className="text-xs text-stone-500">{WEB.buyHint}</p>
          {store === "stripe" && (
            <button type="button" className={`${btnGhost} w-full`} disabled={!!busy} onClick={manageOnWeb} data-web-manage>
              <ExternalLink size={14} />
              {WEB.manage}
            </button>
          )}
        </div>
      ) : !capability.available ? (
        <p className="mt-3 text-xs text-stone-500" data-purchase-unavailable>
          {unavailable}
        </p>
      ) : (
        <div className="mt-4 space-y-4" data-purchase-controls>
          {grouped.tiers.map((group) => (
            <div key={group.tier} className="space-y-1.5">
              {group.packages.map(({ pkg, tier: t, duration }) => (
                <button
                  key={pkg.identifier}
                  type="button"
                  className={`${btnPrimary} w-full`}
                  disabled={!!busy}
                  onClick={() => buy(pkg)}
                  data-package={pkg.identifier}
                >
                  {buyLabel(t, duration, pkg.product && pkg.product.priceString)}
                </button>
              ))}
            </div>
          ))}
          {/* A package our table does not recognise is SHOWN, with
              whatever the store called it. Hiding something a student is
              entitled to buy because a dashboard id was mistyped is the
              worse of the two failures. */}
          {grouped.unrecognised.map((pkg) => (
            <button
              key={pkg.identifier}
              type="button"
              className={`${btnGhost} w-full`}
              disabled={!!busy}
              onClick={() => buy(pkg)}
              data-package={pkg.identifier}
            >
              {(pkg.product && pkg.product.title) || pkg.identifier}
              {pkg.product && pkg.product.priceString ? ` · ${pkg.product.priceString}` : ""}
            </button>
          ))}

          <div>
            <button type="button" className={`${btnGhost} w-full`} disabled={!!busy} onClick={restore} data-restore>
              <RefreshCw size={14} />
              {ACTIONS.restore}
            </button>
            <p className="mt-1 text-xs text-stone-500">{ACTIONS.restoreHint}</p>
          </div>
        </div>
      )}

      <div className="mt-4 space-y-1 text-xs text-stone-500">
        <p>{DISCLOSURES.autoRenew}</p>
        <p>{DISCLOSURES.noRollover}</p>
        <p>{DISCLOSURES.refund}</p>
        <p>{DISCLOSURES.managedByStore}</p>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {manageUrl && (
          <a className="inline-flex items-center gap-1 text-stone-500 hover:u-accent-text" href={manageUrl} target="_blank" rel="noreferrer" data-manage>
            {ACTIONS.manage}
            <ExternalLink size={11} />
          </a>
        )}
        {/* Our terms on web and desktop, Apple's licence on a native
            shell. termsLink returns the href and the label together so
            the two cannot disagree about which agreement this is. */}
        <a className="inline-flex items-center gap-1 text-stone-500 hover:u-accent-text" href={terms.href} target="_blank" rel="noreferrer" data-terms>
          {terms.label}
          <ExternalLink size={11} />
        </a>
        <a className="inline-flex items-center gap-1 text-stone-500 hover:u-accent-text" href={LINKS.privacy} target="_blank" rel="noreferrer" data-privacy>
          {ACTIONS.privacy}
          <ExternalLink size={11} />
        </a>
      </div>
    </Card>
  );
}

/* Re-exported so PlannerApp can nudge every reader after a sign-in or a
   sign-out without importing two modules for one call. */
export { bumpEntitlement };
