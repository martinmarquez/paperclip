import { randomBytes, randomUUID } from "node:crypto";

// Small native operator surface: no UI build, stored credential, automatic retry or polling.
export function reviewPreflightOperatorPage(companyId: string) {
  const nonce = randomBytes(24).toString("base64");
  const path = `/api/companies/${companyId}/review-preflight-extractions`;
  const key = randomUUID();
  return { nonce, html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Review preflight</title></head>
<body><main><h1>Review preflight</h1>
<p>Collect the configured Board and host evidence for this organization.</p>
<p>The result is diagnostic. Reviewer admission stays on HOLD.</p>
<button id="collect" type="button">Collect diagnostic preflight</button>
<p id="result" role="status" aria-live="polite"></p></main>
<script nonce="${nonce}">
const button = document.getElementById("collect");
const result = document.getElementById("result");
button.addEventListener("click", async () => {
  button.disabled = true;
  result.textContent = "Collecting evidence…";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(${JSON.stringify(path)}, { method: "POST", credentials: "same-origin",
      redirect: "error", signal: controller.signal, body: "{}",
      headers: { "Content-Type": "application/json", "Idempotency-Key": ${JSON.stringify(key)} } });
    const data = await response.json();
    if (!response.ok) {
      result.textContent = response.status === 429 ? "An extraction already used this hour."
        : response.status === 409 ? "An existing request needs inspection before another extraction."
        : "Preflight is unavailable. Check the current authorization and candidate.";
      return;
    }
    result.textContent = typeof data.requestId === "string"
      ? "Request " + data.requestId + " · " + String(data.status) + " · HOLD"
      : "The request needs inspection. Reviewer admission remains on HOLD.";
  } catch {
    result.textContent = "The result is uncertain. Inspect the existing request before trying again.";
  } finally { clearTimeout(timer); }
});
</script></body></html>` };
}
