import type { CheckoutSession } from "../domain/session.js";

// The payment page: small HTML pages without any external resource. Every value that comes from a caller (metadata,
// amount, ids) goes through escapeHtml before it is written into the page.

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** 1234 cents in EUR -> "12.34 EUR". */
export function formatAmount(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency}`;
}

/**
 * The origin of a return URL if it is a plain scheme, host and port; otherwise null. Only such a value may be written
 * into the Content-Security-Policy header, because a host name could hold characters that the header uses as separators.
 */
function safeOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin) ? origin : null;
  } catch {
    return null;
  }
}

/**
 * The CSP of every page: nothing is loaded from anywhere (default-src 'none'), the inline style is allowed, and the
 * form posts only to this site. The page that has the Pay and Decline buttons also names the origins of the
 * session's two return URLs in form-action: the buttons answer with a redirect to one of them, and Chrome applies
 * form-action to that redirect as well (Firefox does not), so without them the buyer would never get back to the shop.
 */
export function contentSecurityPolicy(session?: CheckoutSession): string {
  const returnOrigins = session ? [safeOrigin(session.successUrl), safeOrigin(session.cancelUrl)] : [];
  const formAction = ["'self'", ...new Set(returnOrigins.filter((origin): origin is string => origin !== null))];
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction.join(" ")}; base-uri 'none'; frame-ancestors 'none'`;
}

/** Headers of every page. */
export function pageHeaders(session?: CheckoutSession): Record<string, string> {
  return {
    "content-security-policy": contentSecurityPolicy(session),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "x-robots-tag": "noindex",
  };
}

const STYLE = `
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f4f5f7;color:#1c2330}
main{max-width:26rem;margin:3rem auto;padding:1.5rem;background:#fff;border:1px solid #d5d9e0;border-radius:.5rem}
.badge{display:inline-block;margin:0 0 1rem;padding:.15rem .6rem;background:#fff3cd;border-radius:1rem;font-size:.85rem}
h1{margin:0 0 1rem;font-size:1.5rem}
dl{margin:0 0 1rem;font-size:.9rem}
dt{float:left;clear:left;margin-right:.5rem;color:#5a6577}
dd{margin:0 0 .25rem;overflow-wrap:anywhere}
form{margin:0 0 .5rem}
button{width:100%;padding:.7rem;font:inherit;border-radius:.4rem;border:1px solid #8a94a6;background:#fff;cursor:pointer}
button.pay{background:#1a6b3c;border-color:#1a6b3c;color:#fff}
p.note{margin:1rem 0 0;font-size:.85rem;color:#5a6577}
a{color:#1a56a0}
`;

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="badge">Test payment: no real money moves</p>
${body}
</main>
</body>
</html>
`;
}

/** The page of an open session: what is paid, and the two buttons. The forms post to ./pay and ./decline next to it. */
export function renderCheckoutPage(session: CheckoutSession): string {
  const amount = escapeHtml(formatAmount(session.amount, session.currency));
  const details = Object.entries(session.metadata)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  const id = escapeHtml(encodeURIComponent(session.id));
  return layout(
    "Test payment",
    `<h1>Pay ${amount}</h1>
${details ? `<dl>${details}</dl>\n` : ""}<form method="post" action="${id}/pay"><button class="pay" type="submit">Pay ${amount}</button></form>
<form method="post" action="${id}/decline"><button type="submit">Decline</button></form>
<p class="note">Payment ${escapeHtml(session.id)}, open until ${escapeHtml(session.expiresAt.toISOString())}.</p>`,
  );
}

const FINAL_TEXT: Record<string, string> = {
  completed: "This payment is already completed.",
  declined: "This payment was declined.",
  expired: "This payment has expired.",
};

/** The page of a session that cannot change any more: says what it is, and offers the way back to the shop. */
export function renderFinalPage(session: CheckoutSession): string {
  const target = session.status === "completed" ? session.successUrl : session.cancelUrl;
  const label = session.status === "completed" ? "Continue to the shop" : "Back to the shop";
  return layout(
    "Payment closed",
    `<h1>${escapeHtml(FINAL_TEXT[session.status] ?? "This payment is closed.")}</h1>
<p><a href="${escapeHtml(target)}">${label}</a></p>
<p class="note">Payment ${escapeHtml(session.id)}</p>`,
  );
}

/** The page for an id nobody knows (it may have been forgotten after a restart of the provider). */
export function renderNotFoundPage(): string {
  return layout(
    "Payment not found",
    `<h1>This payment does not exist.</h1>
<p class="note">The link may be wrong, or the provider was restarted and forgot it.</p>`,
  );
}
