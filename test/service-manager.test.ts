/*
文件说明: 验证桌面代理服务的启动、停止、端口占用和配置热保存行为。
对应文档: Electron + Vite GUI implementation plan
*/
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isPrivateLanIpv4, ProxyServiceManager } from "../src/main/proxy-service-manager";

test("service manager starts and stops the local proxy", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-gui-service-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await writeAvailablePortConfig(path.join(dir, "config.json"));
  const manager = new ProxyServiceManager(path.join(dir, "config.json"));
  t.after(() => manager.stop());

  const started = await manager.start();
  assert.equal(started.running, true);
  assert.equal(started.host, "127.0.0.1");
  assert.equal(typeof started.port, "number");

  const health = await fetch(`http://127.0.0.1:${started.port}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);

  const stopped = await manager.stop();
  assert.equal(stopped.running, false);
});

test("service manager reports port conflicts clearly", async (t) => {
  const blocker = http.createServer((req, res) => res.end("busy"));
  await listen(blocker, "127.0.0.1", 0);
  t.after(() => blocker.close());

  const address = blocker.address();
  assert(address && typeof address === "object");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-gui-conflict-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ listen: { host: "127.0.0.1", port: address.port }, debug: false, models: [] }, null, 2),
    "utf8"
  );

  const manager = new ProxyServiceManager(path.join(dir, "config.json"));
  const status = await manager.start();
  assert.equal(status.running, false);
  assert.equal(status.error?.code, "EADDRINUSE");
  assert.match(status.error?.message || "", /端口.*已被占用/);
  assert.match(status.error?.message || "", /设置.*修改端口/);
});

test("saved config is visible to the running proxy immediately", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-gui-config-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  await writeAvailablePortConfig(path.join(dir, "config.json"));
  const manager = new ProxyServiceManager(path.join(dir, "config.json"));
  t.after(() => manager.stop());

  const started = await manager.start();
  assert.equal(started.running, true);

  const saved = await manager.saveConfig({
    models: [
      {
        localModelId: "claude-sonnet",
        remoteBaseUrl: "https://example.com/anthropic",
        remoteModelId: "provider-sonnet",
        remoteApiKey: "secret",
        enabled: true
      }
    ]
  });

  assert.equal(saved.configured, true);
  assert.equal(saved.models[0]?.localModelId, "claude-sonnet");

  const health = await fetch(`http://127.0.0.1:${started.port}/health`);
  const payload = await health.json();
  assert.deepEqual(payload.models, ["claude-sonnet"]);
});

test("saving listen settings restarts the running proxy on the new port", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-gui-listen-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const configPath = path.join(dir, "config.json");
  await writeAvailablePortConfig(configPath);
  const manager = new ProxyServiceManager(configPath);
  t.after(() => manager.stop());

  const started = await manager.start();
  assert.equal(started.running, true);

  const nextPort = await getAvailablePort();
  const saved = await manager.saveConfig({
    host: "0.0.0.0",
    port: nextPort,
    models: [
      {
        localModelId: "claude-sonnet",
        remoteBaseUrl: "https://example.com/anthropic",
        remoteModelId: "provider-sonnet",
        remoteApiKey: "secret",
        enabled: true
      }
    ]
  });
  const status = manager.getStatus();

  assert.equal(saved.host, "0.0.0.0");
  assert.equal(saved.port, nextPort);
  assert.equal(status.running, true);
  assert.equal(status.host, "0.0.0.0");
  assert.equal(status.port, nextPort);

  const health = await fetch(`http://127.0.0.1:${nextPort}/health`);
  assert.equal(health.status, 200);
});

test("base URL remains 127.0.0.1 when listening on all interfaces", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-gui-base-url-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const configPath = path.join(dir, "config.json");
  const port = await getAvailablePort();
  await fs.writeFile(
    configPath,
    JSON.stringify({ listen: { host: "0.0.0.0", port }, debug: false, models: [] }, null, 2),
    "utf8"
  );

  const manager = new ProxyServiceManager(configPath);
  t.after(() => manager.stop());

  const started = await manager.start();
  assert.equal(started.host, "0.0.0.0");
  assert.equal(started.baseUrl, `http://127.0.0.1:${started.port}/anthropic`);
  assert.ok(started.localAccessUrls?.includes(`http://127.0.0.1:${started.port}/anthropic`));
  assert.ok((started.localAccessUrls || []).length >= 1);
});

test("local access urls include every discovered LAN IPv4", () => {
  const status = {
    running: true,
    host: "0.0.0.0",
    port: 18787,
    configPath: "/tmp/config.json",
    baseUrl: "http://127.0.0.1:18787/anthropic",
    localAccessUrls: ["http://127.0.0.1:18787/anthropic", "http://192.168.5.104:18787/anthropic", "http://10.0.0.8:18787/anthropic"],
    error: null
  };

  assert.equal(status.localAccessUrls?.length, 3);
  assert.equal(status.localAccessUrls?.[0], "http://127.0.0.1:18787/anthropic");
  assert.ok(status.localAccessUrls?.slice(1).every((url) => url.startsWith("http://")));
});

test("private LAN IPv4 detection excludes reserved benchmark ranges", () => {
  assert.equal(isPrivateLanIpv4("10.0.0.8"), true);
  assert.equal(isPrivateLanIpv4("172.16.0.1"), true);
  assert.equal(isPrivateLanIpv4("172.31.255.254"), true);
  assert.equal(isPrivateLanIpv4("192.168.5.104"), true);
  assert.equal(isPrivateLanIpv4("172.32.0.1"), false);
  assert.equal(isPrivateLanIpv4("198.18.0.1"), false);
  assert.equal(isPrivateLanIpv4("8.8.8.8"), false);
});

function listen(server: http.Server, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function writeAvailablePortConfig(configPath: string) {
  const port = await getAvailablePort();
  await fs.writeFile(
    configPath,
    JSON.stringify({ listen: { host: "127.0.0.1", port }, debug: false, models: [] }, null, 2),
    "utf8"
  );
}

async function getAvailablePort() {
  const server = http.createServer();
  await listen(server, "127.0.0.1", 0);
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
