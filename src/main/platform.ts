/*
文件说明: 汇总桌面端跨平台行为决策，包括登录自启策略、Linux autostart 写入和窗口关闭兜底逻辑。
对应文档: Electron + Vite GUI implementation plan
*/
import fs from "node:fs/promises";
import path from "node:path";

export type CloseAction = "hide" | "minimize";

export function shouldUseNativeLoginItemSettings(platform: NodeJS.Platform) {
  return platform === "darwin" || platform === "win32";
}

export function chooseWindowCloseAction(input: { trayAvailable: boolean; platform: NodeJS.Platform }): CloseAction {
  return input.trayAvailable || input.platform === "darwin" ? "hide" : "minimize";
}

export function buildAutostartDesktopPath(appDataPath: string, appName: string) {
  return path.join(appDataPath, "autostart", `${sanitizeDesktopFileName(appName)}.desktop`);
}

export function buildAutostartDesktopEntry(input: {
  appName: string;
  executablePath: string;
  args?: string[];
}) {
  const execParts = [input.executablePath, ...(input.args || [])].map(escapeDesktopValue).join(" ");
  return [
    "[Desktop Entry]",
    "Type=Application",
    `Name=${input.appName}`,
    `Exec=${execParts}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true"
  ].join("\n") + "\n";
}

export async function syncLinuxAutostartEntry(input: {
  enabled: boolean;
  appDataPath: string;
  appName: string;
  executablePath: string;
  args?: string[];
}) {
  const autostartPath = buildAutostartDesktopPath(input.appDataPath, input.appName);
  if (!input.enabled) {
    await fs.rm(autostartPath, { force: true });
    return autostartPath;
  }

  await fs.mkdir(path.dirname(autostartPath), { recursive: true });
  await fs.writeFile(
    autostartPath,
    buildAutostartDesktopEntry({
      appName: input.appName,
      executablePath: input.executablePath,
      args: input.args
    }),
    "utf8"
  );
  return autostartPath;
}

function sanitizeDesktopFileName(value: string) {
  return value.trim().replace(/\s+/g, "-");
}

function escapeDesktopValue(value: string) {
  return value.replace(/([\\\s])/g, "\\$1");
}
