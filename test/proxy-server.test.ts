/*
文件说明: 验证代理 HTTP 接口保持上游项目兼容，包括路径转发、鉴权替换和配置 API。
参考资料: claude-client-adapter test/server.test.js
对应文档: Electron + Vite GUI implementation plan
*/
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeConfig } from "../src/main/proxy/config";
import { createConfigState, createServer, stripAnthropicPrefix } from "../src/main/proxy/server";

test("POST /api/config saves multi-model JSON and returns keys for local editing", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-gui-server-"));
  const configPath = path.join(dir, "config.json");
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const state = await createConfigState(configPath);
  const proxy = createServer(state);
  await listen(proxy, "127.0.0.1", 0);
  t.after(() => proxy.close());

  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress === "object");

  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/api/config`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      models: [
        {
          localModelId: "claude-sonnet",
          remoteBaseUrl: "https://sonnet.example.com",
          remoteApiKey: "sonnet-key",
          remoteModelId: "provider-sonnet"
        }
      ]
    })
  });

  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.config.models[0].remoteApiKey, "sonnet-key");

  const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(saved.models[0].remoteApiKey, "sonnet-key");
});

test("POST /anthropic/v1/messages forwards to mapped Anthropic remote", async (t) => {
  let remoteRequest: {
    method?: string;
    url?: string;
    headers?: http.IncomingHttpHeaders;
    body?: Record<string, any>;
  } = {};

  const remote = http.createServer(async (req, res) => {
    const body = await readBody(req);
    remoteRequest = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: JSON.parse(body)
    };

    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: remoteRequest.body?.model, content: [] }));
  });

  await listen(remote, "127.0.0.1", 0);
  t.after(() => remote.close());

  const remoteAddress = remote.address();
  assert(remoteAddress && typeof remoteAddress === "object");

  const state = readOnlyState({
    models: [
      {
        localModelId: "claude-3-5-sonnet-20241022",
        remoteModelId: "provider-sonnet",
        remoteBaseUrl: `http://127.0.0.1:${remoteAddress.port}`,
        remoteApiKey: "remote-key"
      }
    ]
  });

  const proxy = createServer(state);
  await listen(proxy, "127.0.0.1", 0);
  t.after(() => proxy.close());

  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress === "object");

  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/anthropic/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "local-key",
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 8,
      messages: [{ role: "user", content: "hello" }]
    })
  });

  assert.equal(response.status, 200);
  assert.equal(remoteRequest.method, "POST");
  assert.equal(remoteRequest.url, "/v1/messages");
  assert.equal(remoteRequest.headers?.["x-api-key"], "remote-key");
  assert.equal(remoteRequest.headers?.["anthropic-version"], "2023-06-01");
  assert.equal(remoteRequest.body?.model, "provider-sonnet");
});

test("GET /anthropic prefixed paths preserve path and query", async (t) => {
  let remoteUrl = "";
  const remote = http.createServer((req, res) => {
    remoteUrl = req.url || "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });

  await listen(remote, "127.0.0.1", 0);
  t.after(() => remote.close());

  const remoteAddress = remote.address();
  assert(remoteAddress && typeof remoteAddress === "object");

  const proxy = createServer(
    readOnlyState({
      models: [
        {
          localModelId: "claude-default",
          remoteModelId: "provider-default",
          remoteBaseUrl: `http://127.0.0.1:${remoteAddress.port}`,
          remoteApiKey: ""
        }
      ]
    })
  );
  await listen(proxy, "127.0.0.1", 0);
  t.after(() => proxy.close());

  const proxyAddress = proxy.address();
  assert(proxyAddress && typeof proxyAddress === "object");

  const response = await fetch(`http://127.0.0.1:${proxyAddress.port}/anthropic/v1/models?limit=20`);
  assert.equal(response.status, 200);
  assert.equal(remoteUrl, "/v1/models?limit=20");
});

test("stripAnthropicPrefix preserves path and query", () => {
  assert.equal(stripAnthropicPrefix("/anthropic/v1/messages?x=1"), "/v1/messages?x=1");
  assert.equal(stripAnthropicPrefix("/anthropic"), "/");
});

function readOnlyState(configInput: Record<string, unknown>) {
  const config = normalizeConfig(configInput, "/tmp/config.json");
  return {
    configPath: "/tmp/config.json",
    getConfig: () => config,
    getError: () => null,
    getLogger: () => ({ debug: async () => {} }),
    save: async () => {
      throw Object.assign(new Error("只读配置不能保存。"), { statusCode: 405 });
    }
  };
}

function listen(server: http.Server, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
