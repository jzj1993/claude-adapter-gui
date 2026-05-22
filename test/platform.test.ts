/*
文件说明: 验证跨平台桌面行为决策，包括登录自启策略、Linux autostart 文件和关闭窗口兜底动作。
对应文档: Electron + Vite GUI implementation plan
*/
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAutostartDesktopEntry,
  buildAutostartDesktopPath,
  chooseWindowCloseAction,
  syncLinuxAutostartEntry,
  shouldUseNativeLoginItemSettings
} from "../src/main/platform";

test("native login item settings are only used on macOS and Windows", () => {
  assert.equal(shouldUseNativeLoginItemSettings("darwin"), true);
  assert.equal(shouldUseNativeLoginItemSettings("win32"), true);
  assert.equal(shouldUseNativeLoginItemSettings("linux"), false);
});

test("linux autostart desktop entry contains executable and app metadata", () => {
  const entry = buildAutostartDesktopEntry({
    appName: "Claude Companion",
    executablePath: "/Applications/Claude Companion/Claude Companion",
    args: ["--hidden"]
  });

  assert.match(entry, /^\[Desktop Entry\]/m);
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Name=Claude Companion$/m);
  assert.match(entry, /^Terminal=false$/m);
  assert.match(entry, /^Exec=\/Applications\/Claude\\ Companion\/Claude\\ Companion --hidden$/m);
});

test("autostart desktop path is written under the config autostart directory", () => {
  assert.equal(
    buildAutostartDesktopPath("/home/alice/.config", "Claude Companion"),
    "/home/alice/.config/autostart/Claude-Companion.desktop"
  );
});

test("linux autostart entry can be removed when disabled", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-companion-autostart-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const autostartPath = await syncLinuxAutostartEntry({
    enabled: true,
    appDataPath: dir,
    appName: "Claude Companion",
    executablePath: "/usr/bin/claude-companion"
  });

  assert.equal(await fs.readFile(autostartPath, "utf8"), buildAutostartDesktopEntry({
    appName: "Claude Companion",
    executablePath: "/usr/bin/claude-companion"
  }));

  await syncLinuxAutostartEntry({
    enabled: false,
    appDataPath: dir,
    appName: "Claude Companion",
    executablePath: "/usr/bin/claude-companion"
  });

  await assert.rejects(fs.readFile(autostartPath, "utf8"));
});

test("window close hides when tray exists and minimizes otherwise", () => {
  assert.equal(chooseWindowCloseAction({ trayAvailable: true, platform: "linux" }), "hide");
  assert.equal(chooseWindowCloseAction({ trayAvailable: false, platform: "linux" }), "minimize");
  assert.equal(chooseWindowCloseAction({ trayAvailable: false, platform: "darwin" }), "hide");
  assert.equal(chooseWindowCloseAction({ trayAvailable: false, platform: "win32" }), "minimize");
});
