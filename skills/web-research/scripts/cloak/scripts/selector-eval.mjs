// selector-eval.mjs — runs inside cloak-script.mjs (stealth Chromium).
// Evaluates a CSS selector against the fully-rendered DOM, so the --selector
// intent survives the camofox→cloak escalation (cloak-fetch.mjs only does text/html).
//
// URL + selector injected via env (WR_URL / WR_SELECTOR) — never string-interpolated
// into source, so quotes/backticks in input can't break out.
//
// Invoke via:
//   WR_URL=... WR_SELECTOR=... node cloak-script.mjs --script selector-eval.mjs
export default async ({ page }) => {
  const url = process.env.WR_URL;
  const selector = process.env.WR_SELECTOR;
  if (!url || !selector)
    throw new Error("WR_URL and WR_SELECTOR env vars required");

  // domcontentloaded first (fast), then try to settle lazy/SPA content.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  try {
    await page.waitForLoadState("networkidle", { timeout: 5000 });
  } catch {}

  // page.evaluate is sandbox-whitelisted; querySelectorAll + innerText in-page.
  const { text, count, finalUrl, title } = await page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll(sel));
    return {
      count: els.length,
      text: els.map((e) => e.innerText || "").join("\n\n"),
      finalUrl: location.href,
      title: document.title || "",
    };
  }, selector);

  return { url: finalUrl, title, selector, matched: count, text };
};
