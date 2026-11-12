import { describe, expect, it } from "vitest";
import { newSession } from "../../src/domain/session.js";
import { contentSecurityPolicy, escapeHtml, formatAmount, pageHeaders, renderCheckoutPage } from "../../src/web/checkout-page.js";
import { CANCEL_URL, SUCCESS_URL, createHarness, sessionBody } from "../support/harness.js";

const ID = "cs_000000000000000000000001";

/** A script, an event handler, a quote that closes an attribute, an ampersand and an apostrophe. */
const HOSTILE = {
  '<script>alert("k")</script>': `"><img src=x onerror=alert(1)>`,
  "a&b": "it's <b>bold</b> & \"quoted\"",
};

describe("GET /checkout/{id}", () => {
  it("shows the amount, the metadata and the two buttons that post next to the page", async () => {
    const h = await createHarness();
    await h.createSession();
    const response = await h.call({ method: "GET", url: `/checkout/${ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    const page = response.body;
    expect(page).toContain("<h1>Pay 12.50 EUR</h1>");
    expect(page).toContain("<dt>depositId</dt><dd>dep-1</dd>");
    expect(page).toContain(`<form method="post" action="${ID}/pay">`);
    expect(page).toContain(`<form method="post" action="${ID}/decline">`);
    expect(page).toContain("Test payment: no real money moves");
    expect(page).toContain("2026-11-01T10:30:00.000Z");
  });

  it("escapes every value that a caller chose", async () => {
    const h = await createHarness();
    const created = await h.createSession("k", sessionBody({ metadata: HOSTILE }));
    expect(created.statusCode).toBe(201);
    const page = (await h.call({ method: "GET", url: `/checkout/${ID}` })).body;

    // Nothing of the hostile text survives as markup ...
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<img");
    expect(page).not.toContain("<b>");
    expect(page).not.toMatch(/onerror=alert\(1\)>/);
    // ... it is there as text.
    expect(page).toContain("&lt;script&gt;alert(&quot;k&quot;)&lt;/script&gt;");
    expect(page).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
    expect(page).toContain("a&amp;b");
    expect(page).toContain("it&#39;s &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;");
    // The page has exactly the two forms, the style and no script of its own.
    expect(page.match(/<form /g)).toHaveLength(2);
    expect(page.match(/<script/gi)).toBeNull();
  });

  it("escapes the amount and the currency", () => {
    expect(formatAmount(1234, "EUR")).toBe("12.34 EUR");
    expect(formatAmount(5, "EUR")).toBe("0.05 EUR");
    expect(formatAmount(1_000_000, "EUR")).toBe("10000.00 EUR");
    expect(escapeHtml(formatAmount(1, "<EUR>&"))).toBe("0.01 &lt;EUR&gt;&amp;");
    // A session object that no validation made: the page still writes only escaped text.
    const session = { ...newSession({ amount: 1, currency: "EUR", successUrl: SUCCESS_URL, cancelUrl: CANCEL_URL }, { id: 'cs_"><x', now: new Date(), ttlMinutes: 1 }), currency: "<i>" as never };
    const page = renderCheckoutPage(session);
    expect(page).not.toContain("<i>");
    expect(page).not.toContain('"><x');
    expect(page).toContain("&lt;i&gt;");
  });

  it("sends a Content-Security-Policy that loads nothing, and the other protective headers", async () => {
    const h = await createHarness();
    await h.createSession();
    const response = await h.call({ method: "GET", url: `/checkout/${ID}` });
    const csp = String(response.headers["content-security-policy"]);

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("style-src 'unsafe-inline'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src|img-src|connect-src|\*/);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-robots-tag"]).toBe("noindex");
    // No external resource anywhere in the page.
    expect(response.body).not.toMatch(/(src|href)\s*=\s*["']?https?:/i);
    expect(response.body).not.toMatch(/<link|<script|<img|<iframe|@import|url\(/i);
  });

  it("names the origins of the two return URLs in form-action, because Chrome applies it to the redirect", async () => {
    const h = await createHarness();
    await h.createSession("k", sessionBody({ successUrl: "https://shop.example.test:8443/ok", cancelUrl: "http://localhost:5173/no" }));
    const csp = String((await h.call({ method: "GET", url: `/checkout/${ID}` })).headers["content-security-policy"]);
    expect(csp).toContain("form-action 'self' https://shop.example.test:8443 http://localhost:5173;");
  });

  it("writes an origin into the policy only when it is plain, so that no caller can add a directive", () => {
    const session = (successUrl: string, cancelUrl: string) =>
      newSession({ amount: 1, currency: "EUR", successUrl, cancelUrl }, { id: "cs_1", now: new Date(), ttlMinutes: 1 });
    // A semicolon and a comma are legal in a host name; they would end the directive.
    const sneaky = contentSecurityPolicy(session("http://a;b.example/ok", "https://shop.example.test/no"));
    expect(sneaky).toContain("form-action 'self' https://shop.example.test;");
    expect(sneaky).not.toContain("a;b");
    expect(sneaky.split(";").map((directive) => directive.trim().split(" ")[0])).toEqual(["default-src", "style-src", "form-action", "base-uri", "frame-ancestors"]);
    // Two return URLs on one origin give one entry; an IPv6 literal is left out.
    expect(contentSecurityPolicy(session("https://shop.example.test/a", "https://shop.example.test/b"))).toContain("form-action 'self' https://shop.example.test;");
    expect(contentSecurityPolicy(session("http://[::1]:5173/a", "https://shop.example.test/b"))).toContain("form-action 'self' https://shop.example.test;");
    // Pages without a session (the final pages) post nowhere but here.
    expect(contentSecurityPolicy()).toContain("form-action 'self';");
    expect(pageHeaders()["content-security-policy"]).toContain("default-src 'none'");
  });

  it("answers 404 with a page for an id nobody knows", async () => {
    const h = await createHarness();
    const response = await h.call({ method: "GET", url: "/checkout/cs_unknown" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(response.body).toContain("This payment does not exist.");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  });
});

describe("POST /checkout/{id}/pay and /decline", () => {
  it("pay: redirects with 303 to the success URL, completes the session and queues the event", async () => {
    const h = await createHarness();
    await h.createSession();
    const response = await h.call({ method: "POST", url: `/checkout/${ID}/pay` });

    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe(SUCCESS_URL);
    expect(response.body).toBe("");
    expect((await h.api("GET", `/v1/checkout-sessions/${ID}`)).json().status).toBe("completed");
    expect(h.webhooks.events).toHaveLength(1);
    expect(h.webhooks.events[0]).toMatchObject({ type: "checkout.session.completed", data: { object: "checkout_session", id: ID } });
  });

  it("decline: redirects with 303 to the cancel URL, declines the session and queues the event", async () => {
    const h = await createHarness();
    await h.createSession();
    const response = await h.call({ method: "POST", url: `/checkout/${ID}/decline` });

    expect(response.statusCode).toBe(303);
    expect(response.headers["location"]).toBe(CANCEL_URL);
    expect((await h.api("GET", `/v1/checkout-sessions/${ID}`)).json().status).toBe("declined");
    expect(h.webhooks.types()).toEqual(["checkout.session.declined"]);
  });

  it("works for a form post the way a browser sends it: urlencoded, with or without fields", async () => {
    const h = await createHarness();
    await h.createSession("k1");
    await h.createSession("k2");
    const bare = await h.call({ method: "POST", url: "/checkout/cs_000000000000000000000001/pay", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "" });
    expect(bare.statusCode).toBe(303);
    const withFields = await h.call({ method: "POST", url: "/checkout/cs_000000000000000000000002/decline", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "status=completed&amount=1" });
    expect(withFields.statusCode).toBe(303);
    expect(withFields.headers["location"]).toBe(CANCEL_URL);
    expect((await h.api("GET", "/v1/checkout-sessions/cs_000000000000000000000002")).json().status).toBe("declined");
  });

  it("changes a session once: the second click, and the other button, get a 409 page that says what it is", async () => {
    const h = await createHarness();
    await h.createSession();
    await h.call({ method: "POST", url: `/checkout/${ID}/pay` });

    const again = await h.call({ method: "POST", url: `/checkout/${ID}/pay` });
    expect(again.statusCode).toBe(409);
    expect(again.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(again.body).toContain("This payment is already completed.");
    expect(again.body).toContain(`href="${SUCCESS_URL}"`);
    expect(again.headers["location"]).toBeUndefined();

    const other = await h.call({ method: "POST", url: `/checkout/${ID}/decline` });
    expect(other.statusCode).toBe(409);
    expect(other.body).toContain("This payment is already completed.");
    expect(h.webhooks.events).toHaveLength(1);

    const page = await h.call({ method: "GET", url: `/checkout/${ID}` });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain("This payment is already completed.");
    expect(page.body).not.toContain("<form");
  });

  it("shows a declined session as declined, with a way back to the shop", async () => {
    const h = await createHarness();
    await h.createSession();
    await h.call({ method: "POST", url: `/checkout/${ID}/decline` });
    const page = await h.call({ method: "GET", url: `/checkout/${ID}` });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain("This payment was declined.");
    expect(page.body).toContain(`href="${CANCEL_URL}"`);
  });

  it("shows a session whose time is up as expired (409), on the page and on both buttons, and queues one event", async () => {
    const h = await createHarness();
    await h.createSession();
    h.clock.advanceMinutes(30);

    const page = await h.call({ method: "GET", url: `/checkout/${ID}` });
    expect(page.statusCode).toBe(409);
    expect(page.body).toContain("This payment has expired.");
    expect(page.body).toContain("Back to the shop");
    expect(page.body).not.toContain("<form");

    for (const action of ["pay", "decline"]) {
      const response = await h.call({ method: "POST", url: `/checkout/${ID}/${action}` });
      expect(response.statusCode, action).toBe(409);
      expect(response.body).toContain("This payment has expired.");
    }
    expect((await h.api("GET", `/v1/checkout-sessions/${ID}`)).json().status).toBe("expired");
    expect(h.webhooks.types()).toEqual(["checkout.session.expired"]);
  });

  it("still lets the buyer pay in the last minute", async () => {
    const h = await createHarness();
    await h.createSession();
    h.clock.advanceMs(30 * 60_000 - 1);
    expect((await h.call({ method: "POST", url: `/checkout/${ID}/pay` })).statusCode).toBe(303);
  });

  it("answers 404 with a page for an unknown id, on both buttons", async () => {
    const h = await createHarness();
    for (const action of ["pay", "decline"]) {
      const response = await h.call({ method: "POST", url: `/checkout/cs_unknown/${action}` });
      expect(response.statusCode, action).toBe(404);
      expect(response.body).toContain("This payment does not exist.");
    }
  });

  it("needs no API key and is not an API route: the payment page is public", async () => {
    const h = await createHarness();
    await h.createSession();
    expect((await h.call({ method: "GET", url: `/checkout/${ID}` })).statusCode).toBe(200);
    expect((await h.call({ method: "POST", url: `/checkout/${ID}/pay` })).statusCode).toBe(303);
  });
});
