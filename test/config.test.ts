/*
文件说明: 验证代理配置中的桌面 UI 设置默认值、公开配置和保存行为。
对应文档: Electron + Vite GUI implementation plan
*/
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeConfig, publicConfig, saveWebConfig } from "../src/main/proxy/config";

test("hide dock on close defaults to enabled", () => {
  const config = normalizeConfig({ listen: { host: "127.0.0.1", port: 18787 }, models: [] }, "/tmp/config.json");
  const exposed = publicConfig(config, config.configPath, null);

  assert.equal(config.ui.hideDockOnClose, true);
  assert.equal(exposed.hideDockOnClose, true);
});

test("startup preferences use requested defaults", () => {
  const config = normalizeConfig({ listen: { host: "127.0.0.1", port: 18787 }, models: [] }, "/tmp/config.json");
  const exposed = publicConfig(config, config.configPath, null);

  assert.equal(config.ui.launchAtLogin, false);
  assert.equal(config.ui.startHiddenToTray, false);
  assert.equal(config.ui.autoStartProxy, true);
  assert.equal(exposed.launchAtLogin, false);
  assert.equal(exposed.startHiddenToTray, false);
  assert.equal(exposed.autoStartProxy, true);
  assert.equal(exposed.debug, false);
});

test("public config base URL stays on 127.0.0.1 even when listening on 0.0.0.0", () => {
  const config = normalizeConfig({ listen: { host: "0.0.0.0", port: 18787 }, models: [] }, "/tmp/config.json");
  const exposed = publicConfig(config, config.configPath, null);

  assert.equal(exposed.localBaseUrl, "http://127.0.0.1:18787");
});

test("saveWebConfig persists hide dock on close preference", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-gui-ui-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const configPath = path.join(dir, "config.json");
  const saved = await saveWebConfig(
    configPath,
    {
      hideDockOnClose: false,
      models: []
    },
    null
  );

  assert.equal(saved.ui.hideDockOnClose, false);
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(raw.ui.hideDockOnClose, false);
});

test("saveWebConfig persists startup preferences", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-gui-startup-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const configPath = path.join(dir, "config.json");
  const saved = await saveWebConfig(
    configPath,
    {
      launchAtLogin: true,
      startHiddenToTray: true,
      autoStartProxy: false,
      models: []
    },
    null
  );

  assert.equal(saved.ui.launchAtLogin, true);
  assert.equal(saved.ui.startHiddenToTray, true);
  assert.equal(saved.ui.autoStartProxy, false);

  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(raw.ui.launchAtLogin, true);
  assert.equal(raw.ui.startHiddenToTray, true);
  assert.equal(raw.ui.autoStartProxy, false);
});

test("saveWebConfig persists debug logging preference", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-adapter-gui-debug-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const configPath = path.join(dir, "config.json");
  const saved = await saveWebConfig(
    configPath,
    {
      debug: true,
      models: []
    },
    null
  );

  assert.equal(saved.debug, true);
  const raw = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(raw.debug, true);
});
