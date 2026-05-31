import { test } from "node:test";
import assert from "node:assert/strict";

import { capMessageBodies } from "../dist/index.js";

// --------------------------------------------------------------------------
// capMessageBodies  (review item #7)
// --------------------------------------------------------------------------
test("capMessageBodies keeps bodies that fit within the budget", () => {
  const r = capMessageBodies([{ body: "aaa" }, { body: "bbb" }], 100);
  assert.equal(r.truncated, false);
  assert.equal(r.messages[0].body, "aaa");
  assert.equal(r.messages[1].body, "bbb");
});

test("capMessageBodies truncates the crossing body and omits later ones", () => {
  const big = [
    { body: "x".repeat(30) },
    { body: "y".repeat(30) },
    { body: "z".repeat(30) },
  ];
  const r = capMessageBodies(big, 20);
  assert.equal(r.truncated, true);
  assert.ok(r.messages[0].body.startsWith("x".repeat(20)));
  assert.match(r.messages[0].body, /truncated/);
  assert.match(r.messages[1].body, /omitted/);
  // Total stays bounded by the budget plus the small markers.
  const total = r.messages.reduce((n, m) => n + m.body.length, 0);
  assert.ok(total < 20 + 200);
});

test("capMessageBodies treats an exact-fit body as not truncated", () => {
  const r = capMessageBodies([{ body: "a".repeat(20) }], 20);
  assert.equal(r.truncated, false);
  assert.equal(r.messages[0].body, "a".repeat(20));
});

test("capMessageBodies does not flag a trailing empty body", () => {
  const r = capMessageBodies([{ body: "a".repeat(20) }, { body: "" }], 20);
  assert.equal(r.truncated, false);
  assert.equal(r.messages[1].body, "");
});

test("capMessageBodies preserves non-body fields", () => {
  const r = capMessageBodies([{ body: "x".repeat(50), message_id: "m1", from: "a@b" }], 10);
  assert.equal(r.messages[0].message_id, "m1");
  assert.equal(r.messages[0].from, "a@b");
});
