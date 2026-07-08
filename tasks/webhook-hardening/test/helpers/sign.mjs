import { createHmac } from "node:crypto";

/**
 * Build the HMAC-SHA256 hex digest for a webhook delivery.
 *
 * Payload signed: `${timestamp}.${rawBody}`
 * Header form:    `X-Webhook-Signature: sha256=<hex>`
 *
 * @param {string} secret
 * @param {string|number} timestamp  unix seconds
 * @param {string} rawBody           exact request body bytes as a string
 * @returns {string} hex digest
 */
export function signPayload(secret, timestamp, rawBody) {
  const payload = `${timestamp}.${rawBody}`;
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/**
 * Convenience: return the headers an authenticated delivery would send.
 *
 * @param {string} secret
 * @param {string} rawBody
 * @param {number} [timestamp=Math.floor(Date.now()/1000)]
 * @returns {{ "X-Webhook-Timestamp": string, "X-Webhook-Signature": string }}
 */
export function signedHeaders(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const hex = signPayload(secret, timestamp, rawBody);
  return {
    "X-Webhook-Timestamp": String(timestamp),
    "X-Webhook-Signature": `sha256=${hex}`,
  };
}
