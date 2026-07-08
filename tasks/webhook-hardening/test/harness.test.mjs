import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signPayload, signedHeaders } from "./helpers/sign.mjs";

// Harness smoke check only — does not import anything from src/.
// Proves npm test works and that the signing helper is stable.

describe("webhook signing helper", () => {
  it("produces a stable known digest for fixed inputs", () => {
    const secret = "whsec_test_benchmark_secret_do_not_use_in_prod";
    const timestamp = 1700000000;
    const rawBody = '{"eventId":"evt_fixed","type":"payment.succeeded","amount":100}';

    // Precomputed: HMAC-SHA256(secret, "1700000000." + rawBody) as hex
    const expected =
      "2e9777aff103df7efa15b2e761e63f1c8a7180a242554b7762d4e61a162567f8";

    const hex = signPayload(secret, timestamp, rawBody);
    assert.equal(hex, expected);

    // Re-run must be identical (stable).
    assert.equal(signPayload(secret, timestamp, rawBody), expected);

    const headers = signedHeaders(secret, rawBody, timestamp);
    assert.equal(headers["X-Webhook-Timestamp"], "1700000000");
    assert.equal(headers["X-Webhook-Signature"], `sha256=${expected}`);
  });
});
