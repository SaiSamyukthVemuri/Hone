#!/usr/bin/env node
// Deployed HTTP acceptance. Unlike middleware unit tests, this reads the
// response AFTER Vercel's CDN transform and the Next App Router renderer.
// Usage: node scripts/verify-agent-readiness.mjs https://preview.example.com
const input = process.argv[2];
if (!input) {
  console.error("Provide a deployed site origin, e.g. https://preview.example.com");
  process.exit(2);
}
const origin = new URL(input);
if (
  (origin.protocol !== "https:" &&
   !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) ||
  origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/"
) {
  console.error("Use a clean HTTPS origin or a localhost HTTP origin without credentials or query");
  process.exit(2);
}

const results = [];
const messages = [];
async function check(path, accept, status, type, required = [], vary = false, method = "GET") {
  const response = await fetch(new URL(path, origin), {
    method,
    headers: { Accept: accept },
    // Fail instead of following an auth redirect to a 200 /login shell.
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
  const body = method === "HEAD" ? "" : await response.text();
  const headerType = (response.headers.get("content-type") ?? "").toLowerCase();
  const varyTokens = (response.headers.get("vary") ?? "").toLowerCase().split(",").map(x => x.trim());
  const failures = [];
  if (response.status !== status) failures.push("expected HTTP " + status + ", got " + response.status);
  if (type && !headerType.startsWith(type)) failures.push("unexpected Content-Type: " + headerType);
  if (vary && !varyTokens.includes("accept")) failures.push("Vary lacks Accept");
  for (const expected of required) if (!body.includes(expected)) failures.push("missing body content: " + expected);
  if (method !== "HEAD" && body.length < 20) failures.push("empty or too-short body");
  const label = method + " " + path + " [Accept: " + accept + "]";
  results.push({ label, passed: failures.length === 0 });
  if (failures.length) messages.push({ label, failures });
  return body;
}

try {
  const md = "text/markdown", html = "text/html";
  await check("/", md, 200, md, ["# Start the next treatment"], true);
  const home = await check("/", html, 200, html, ["<html", "application/ld+json"], true);
  for (const path of ["/about", "/contact", "/about/", "/contact/"]) {
    await check(path, md, 200, md, [path.includes("about") ? "# About Hone" : "# Contact Hone"], true);
    await check(path, html, 200, html, ["<html", "Hone"], true);
  }
  for (const path of ["/not-a-real-hone-page-2026", "/features/not-a-real-page", "/features/not-a-real-page/", "/features/waitlist-invitation", "/features/waitlist-invitation/"]) {
    await check(path, md, 404, md, ["/llms.txt", "/sitemap.xml"], true);
    await check(path, html, 404, html, ["Page not found"], true);
  }
  await check("/not-a-real-hone-page-2026", md, 404, md, [], true, "HEAD");
  await check("/features/treatment-memory/", html, 200, html, [
    "<html", "Remember every treatment, before the client sits down."
  ]);
  await check("/privacy", html, 200, html, ["Privacy"]);
  await check("/llms.txt", "text/plain", 200, "", ["# Hone", "## When to use Hone", "/about", "/contact"]);
  await check("/sitemap.xml", "application/xml", 200, "", ["https://hone.care/about", "https://hone.care/contact"]);
  await check("/robots.txt", "text/plain", 200, "", ["sitemap"]);

  const scripts = [...home.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  const json = scripts.flatMap(m => { try { return [JSON.parse(m[1])]; } catch { return []; } });
  const org = json.find(x => x?.["@type"] === "Organization");
  const orgOk = Boolean(
    Array.isArray(org?.contactPoint) &&
    org.contactPoint.some(x => x.email === "hello@hone.care" && x.contactType === "customer support") &&
    org.address?.addressRegion === "Ontario" &&
    org.address?.addressCountry === "CA"
  );
  results.push({label:"Homepage Organization JSON-LD",passed:orgOk});
  if (!orgOk) messages.push({label:"Homepage Organization JSON-LD",failures:["verified contactPoint/address missing"]});
} catch (err) {
  messages.push({label:"HTTP probe",failures:[err instanceof Error ? err.message : "unknown error"]});
}
const passed = results.filter(r=>r.passed).length;
console.log(JSON.stringify({origin:origin.origin,passed,total:results.length,failed:messages},null,2));
if (messages.length) process.exitCode = 1;
