// Smoke-run the COMPILED output (dist/) — the artifact package.json's bin/main
// and the README's Claude Desktop config actually point at. The test suite runs
// TypeScript source through tsx, so nothing else executes the tsc-emitted
// JS under real Node module resolution (CJS interop of html-to-text,
// @googleapis/gmail, the MCP SDK, ...). This boots the server over real stdio
// MCP, performs an initialize handshake and a tools/list, and runs the
// add-account CLI's --list mode. Plain Node >=18 JavaScript on purpose.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// fileURLToPath handles Windows drive letters correctly; resolving a URL's
// raw .pathname does not (it doubles the drive: "D:\D:\...").
const root = fileURLToPath(new URL("..", import.meta.url));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-mcp-smoke-"));
const env = { ...process.env, GMAIL_MCP_DATA_DIR: dataDir };

// Remove the temp data dir on ANY exit, including the process.exit(1) that
// fail() takes — otherwise every failed run (the common case while debugging a
// dist regression, or a slow machine tripping a watchdog) orphans a dir.
process.on("exit", () => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

const fail = (msg) => {
  console.error(`SMOKE FAIL: ${msg}`);
  process.exit(1);
};

// --- 1. MCP server over stdio: initialize + tools/list ---------------------
await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  let stderr = "";
  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    child.kill();
    fail(`server did not complete the MCP handshake within 20s.\nstderr:\n${stderr}`);
  }, 20_000);

  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    child.kill();
    console.log("smoke: dist/index.js — initialize + tools/list OK");
    resolve();
  };

  child.on("exit", (code) => {
    if (!done) {
      done = true;
      clearTimeout(timer);
      fail(`server exited early (code ${code}).\nstderr:\n${stderr}`);
    }
  });
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => {
    out += d;
    // MCP stdio messages are newline-delimited JSON.
    let idx;
    while ((idx = out.indexOf("\n")) !== -1) {
      const line = out.slice(0, idx).trim();
      out = out.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        fail(`non-JSON line on stdout: ${line.slice(0, 200)}`);
      }
      if (msg.id === 1) {
        const name = msg.result?.serverInfo?.name;
        if (name !== "gmail-mcp-server") {
          fail(`unexpected initialize result: ${line.slice(0, 300)}`);
        }
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
        );
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n"
        );
      } else if (msg.id === 2) {
        const tools = (msg.result?.tools ?? []).map((t) => t.name);
        if (!tools.includes("gmail_get_message") || !tools.includes("gmail_send_message")) {
          fail(`tools/list missing expected tools; got: ${tools.join(", ")}`);
        }
        finish();
      }
    }
  });

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-dist", version: "0.0.0" },
      },
    }) + "\n"
  );
});

// --- 2. add-account CLI: --list on an empty store ---------------------------
await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [path.join(root, "dist", "add-account.js"), "--list"],
    { env }
  );
  let out = "";
  let stderr = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => {
    child.kill();
    fail("add-account --list did not exit within 15s");
  }, 15_000);
  child.on("exit", (code) => {
    clearTimeout(timer);
    if (code !== 0) fail(`add-account --list exited ${code}.\nstderr:\n${stderr}`);
    if (!/No accounts connected/.test(out)) {
      fail(`unexpected --list output: ${out.slice(0, 200)}`);
    }
    console.log("smoke: dist/add-account.js --list OK");
    resolve();
  });
});

// Cleanup runs via the process 'exit' handler above (covers success + failure).
console.log("smoke: PASS");
