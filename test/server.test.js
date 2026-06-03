import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { server } from "../dist/index.js";

/**
 * Connect an in-memory MCP client to the real server and return the tool list
 * exactly as a host would see it (annotations included).
 */
async function listTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    const { tools } = await client.listTools();
    return tools;
  } finally {
    await client.close();
  }
}

test("gmail_send_message is annotated destructive so hosts can gate the send", async () => {
  const tools = await listTools();
  const send = tools.find((t) => t.name === "gmail_send_message");
  assert.ok(send, "gmail_send_message should be registered");
  assert.equal(send.annotations?.destructiveHint, true);
  assert.equal(send.annotations?.readOnlyHint, false);
});

test("read tools are not flagged destructive", async () => {
  const tools = await listTools();
  for (const name of ["gmail_search_threads", "gmail_get_thread", "gmail_list_labels"]) {
    const t = tools.find((x) => x.name === name);
    assert.ok(t, `${name} should be registered`);
    assert.notEqual(t.annotations?.destructiveHint, true, `${name} should not be destructive`);
  }
});
