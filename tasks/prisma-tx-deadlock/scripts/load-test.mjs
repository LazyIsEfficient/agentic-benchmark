import "dotenv/config";
import { createApp } from "../src/app.mjs";
import { prisma } from "../src/lib/prisma.mjs";

// Concurrency-repro harness for the checkout charge endpoint.
//
// It boots the real app in-process, seeds a fresh batch of pending orders, then
// fires N charge requests AT THE SAME TIME (the way a traffic spike hits us) and
// reports how many succeed vs. fail. Run it to see the production symptom for
// yourself:
//
//     npm run load-test
//
// Tune the load with env vars:  CONCURRENCY=40 npm run load-test

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 30);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS ?? 20_000);

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function chargeOne(baseUrl, orderId) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/orders/${orderId}/charge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, status: 0, hung: err.name === "AbortError", body: { error: err.message }, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const batch = `load-${Date.now().toString(36)}`;
  const ids = Array.from({ length: CONCURRENCY }, (_, i) => `${batch}-${i}`);
  await prisma.order.createMany({
    data: ids.map((id, i) => ({ id, status: "pending", amount: 2000 + i, currency: "usd" })),
  });

  const server = await listen(createApp());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`firing ${CONCURRENCY} concurrent charge requests at ${baseUrl} ...\n`);
  const wallStart = Date.now();
  const results = await Promise.all(ids.map((id) => chargeOne(baseUrl, id)));
  const wallMs = Date.now() - wallStart;

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  // Group failures by the error code / message the database reported.
  const byReason = new Map();
  for (const r of failed) {
    const reason = r.hung
      ? `request hung > ${REQUEST_TIMEOUT_MS}ms (never returned)`
      : r.body?.code || r.body?.error || `HTTP ${r.status}`;
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }

  const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const max = latencies[latencies.length - 1];

  console.log("──────────────────────────────────────────────");
  console.log(`requests        : ${results.length}`);
  console.log(`succeeded       : ${ok.length}`);
  console.log(`failed          : ${failed.length}`);
  console.log(`wall clock      : ${wallMs}ms`);
  console.log(`latency p50/p95/max : ${p50}/${p95}/${max} ms`);
  if (byReason.size > 0) {
    console.log(`\nfailures by reason:`);
    for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count.toString().padStart(3)} ×  ${reason}`);
    }
  }
  console.log("──────────────────────────────────────────────");

  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
