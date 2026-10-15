// Run with: npm test
// Checks the policy engine behind every tool against the assignment's scenarios.

import assert from "node:assert/strict";
import { cancelOrder, checkPolicyEligibility, getOrderDetails, normalizeOrderId } from "../lib/orders.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("Order ID normalisation");
test("canonical", () => assert.equal(normalizeOrderId("ORD-101"), "ORD-101"));
test("spaced / lowercase", () => assert.equal(normalizeOrderId("ord 102"), "ORD-102"));
test("digits only", () => assert.equal(normalizeOrderId("103"), "ORD-103"));
test("spoken digits", () => assert.equal(normalizeOrderId("order one zero one"), "ORD-101"));
test("spelled letters", () => assert.equal(normalizeOrderId("O R D 1 0 1"), "ORD-101"));
test("Hindi digits", () => assert.equal(normalizeOrderId("ek shunya teen"), "ORD-103"));
test("filler 'oh' ignored", () => assert.equal(normalizeOrderId("oh it's 101"), "ORD-101"));
test("nothing usable", () => assert.equal(normalizeOrderId("my order"), null));

console.log("get_order_details");
test("ORD-101 out for delivery", () => {
  const r = getOrderDetails({ order_id: "ORD-101" }) as any;
  assert.equal(r.found, true);
  assert.equal(r.status, "Out for Delivery");
  assert.match(r.delivery_note, /6 PM/);
});
test("unknown ID -> ORDER_NOT_FOUND", () => {
  const r = getOrderDetails({ order_id: "ORD-999" }) as any;
  assert.equal(r.found, false);
  assert.equal(r.error, "ORDER_NOT_FOUND");
});
test("missing ID -> MISSING_ORDER_ID", () => {
  const r = getOrderDetails({}) as any;
  assert.equal(r.error, "MISSING_ORDER_ID");
});

console.log("Policy: cancellation");
test("ORD-103 Processing -> eligible", () => assert.equal((checkPolicyEligibility({ order_id: "ORD-103", action: "cancel" }) as any).eligible, true));
test("ORD-101 Out for Delivery -> not eligible, offer refusal", () => {
  const r = checkPolicyEligibility({ order_id: "ORD-101", action: "cancel" }) as any;
  assert.equal(r.eligible, false);
  assert.match(r.alternative, /refuse/);
});
test("cancel_order refuses ORD-101", () => assert.equal((cancelOrder({ order_id: "ORD-101" }) as any).cancelled, false));
test("cancel_order accepts ORD-103", () => {
  const r = cancelOrder({ order_id: "ORD-103" }) as any;
  assert.equal(r.cancelled, true);
  assert.match(r.cancellation_ref, /^CXL-/);
});

console.log("Policy: returns & damage");
test("ORD-102 delivered 14 days ago, opened -> not eligible", () => {
  const r = checkPolicyEligibility({ order_id: "ORD-102", action: "return", product_opened: true }) as any;
  assert.equal(r.eligible, false);
  assert.match(r.reason, /7 days/);
});
test("ORD-102 return even if unopened -> window closed", () =>
  assert.equal((checkPolicyEligibility({ order_id: "ORD-102", action: "return", product_opened: false }) as any).eligible, false));
test("ORD-101 return before delivery -> not eligible", () =>
  assert.equal((checkPolicyEligibility({ order_id: "ORD-101", action: "return" }) as any).eligible, false));
test("ORD-102 damage after 48h -> not eligible", () =>
  assert.equal((checkPolicyEligibility({ order_id: "ORD-102", action: "damage_replacement" }) as any).eligible, false));
test("unknown action rejected", () =>
  assert.equal((checkPolicyEligibility({ order_id: "ORD-102", action: "exchange" }) as any).error, "UNKNOWN_ACTION"));

console.log(`\n${passed} checks passed`);
