/*
文件说明: Electron 主进程入口，负责窗口、托盘、IPC 注册和本地代理服务生命周期。
对应文档: Electron + Vite GUI implementation plan
*/
import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import path from "node:path";
import zlib from "node:zlib";
import { ProxyServiceManager } from "./proxy-service-manager";
import type { ModelConfig, ServiceStatus } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let serviceManager: ProxyServiceManager | null = null;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

async function bootstrap() {
  await app.whenReady();

  serviceManager = new ProxyServiceManager(path.join(app.getPath("userData"), "config.json"));
  const config = await serviceManager.getConfig();
  applyLoginItemSetting(config.launchAtLogin);
  if (config.autoStartProxy) {
    await serviceManager.start();
  }

  registerIpc();
  createTray();
  await createWindow(config.startHiddenToTray);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    } else {
      showFromMenuBar();
    }
  });
}

async function createWindow(startHiddenToTray = false) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 780,
    minWidth: 1080,
    minHeight: 620,
    title: "CLAUDE CLIENT ADAPTER",
    backgroundColor: "#f8fafc",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  if (startHiddenToTray) {
    mainWindow.hide();
    if (process.platform === "darwin" && app.dock) {
      app.dock.hide();
    }
  }

  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideToMenuBar();
    }
  });

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));
  }
}

function registerIpc() {
  if (!serviceManager) {
    throw new Error("服务管理器尚未初始化。");
  }

  ipcMain.handle("service:getStatus", () => serviceManager?.getStatus());
  ipcMain.handle("service:start", async () => {
    const status = await serviceManager?.start();
    refreshTrayMenu();
    return status;
  });
  ipcMain.handle("service:stop", async () => {
    const status = await serviceManager?.stop();
    refreshTrayMenu();
    return status;
  });
  ipcMain.handle("config:get", async () => serviceManager?.getConfig());
  ipcMain.handle("config:save", async (_event, input) => {
    const config = await serviceManager?.saveConfig(input);
    if (config) {
      applyLoginItemSetting(config.launchAtLogin);
      refreshTrayMenu();
    }
    return config;
  });
  ipcMain.handle("app:openConfigFolder", async () => {
    await openConfigFolder();
  });
}

function createTray() {
  tray = new Tray(createTrayImage());
  tray.setTitle("");
  tray.setToolTip("Claude Adapter GUI");
  refreshTrayMenu();
  tray.on("click", () => {
    showTrayMenu();
  });
}

function refreshTrayMenu() {
  if (!tray) return;
  const status = serviceManager?.getStatus();
  const runtimeConfig = serviceManager?.getRuntimeConfig();
  const running = status?.running === true;
  const baseUrl = status?.baseUrl || "http://127.0.0.1:18787/anthropic";
  const baseUrlItems = buildBaseUrlMenuItems(status, baseUrl);
  const modelRouteItems = buildModelRouteMenuItems(runtimeConfig?.models || []);
  const menu = Menu.buildFromTemplate([
    {
      label: mainWindow?.isVisible() ? "隐藏窗口" : "显示窗口",
      click: () => toggleMainWindow()
    },
    {
      label: running ? "停止服务" : "启动服务",
      click: async () => {
        if (running) {
          await serviceManager?.stop();
        } else {
          await serviceManager?.start();
        }
        refreshTrayMenu();
        mainWindow?.webContents.send("service:changed", serviceManager?.getStatus());
      }
    },
    { type: "separator" },
    {
      label: "Base URL",
      submenu: baseUrlItems
    },
    {
      label: `模型映射${runtimeConfig?.models.length ? ` (${runtimeConfig.models.length})` : ""}`,
      submenu: modelRouteItems
    },
    { type: "separator" },
    {
      label: "退出",
      click: async () => {
        await quitApp();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.setTitle("");
  tray.setToolTip(buildTrayTooltip(status));
}

function showTrayMenu() {
  refreshTrayMenu();
  tray?.popUpContextMenu();
}

function createTrayImage() {
  const image = nativeImage.createFromDataURL(createTrayPngDataUrl(18));
  image.setTemplateImage(true);
  return image;
}

function createTrayPngDataUrl(size: number) {
  const pixels = Buffer.alloc(size * size * 4);
  const drawPixel = (x: number, y: number, alpha = 255) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const offset = (y * size + x) * 4;
    pixels[offset] = 0;
    pixels[offset + 1] = 0;
    pixels[offset + 2] = 0;
    pixels[offset + 3] = alpha;
  };
  const drawLine = (x0: number, y0: number, x1: number, y1: number) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 3);
    for (let index = 0; index <= steps; index += 1) {
      const t = index / steps;
      const x = Math.round(x0 + dx * t);
      const y = Math.round(y0 + dy * t);
      for (let yy = -1; yy <= 1; yy += 1) {
        for (let xx = -1; xx <= 1; xx += 1) {
          if (xx * xx + yy * yy <= 1) {
            drawPixel(x + xx, y + yy);
          }
        }
      }
    }
  };

  [
    [9, 2, 9, 6],
    [9, 12, 9, 16],
    [2, 9, 6, 9],
    [12, 9, 16, 9],
    [4, 4, 7, 7],
    [11, 11, 14, 14],
    [14, 4, 11, 7],
    [7, 11, 4, 14]
  ].forEach(([x0, y0, x1, y1]) => drawLine(x0, y0, x1, y1));

  return `data:image/png;base64,${encodePng(size, size, pixels).toString("base64")}`;
}

function encodePng(width: number, height: number, pixels: Buffer) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = (width * 4 + 1) * y;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const target = rowOffset + 1 + x * 4;
      pixels.copy(raw, target, source, source + 4);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toggleMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) {
    hideToMenuBar();
  } else {
    showFromMenuBar();
  }
  refreshTrayMenu();
}

function hideToMenuBar() {
  mainWindow?.hide();
  if (shouldHideDockOnClose() && process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
  refreshTrayMenu();
}

function showFromMenuBar() {
  if (process.platform === "darwin" && app.dock) {
    app.dock.show();
  }
  mainWindow?.show();
  mainWindow?.focus();
  refreshTrayMenu();
}

function shouldHideDockOnClose() {
  return serviceManager?.getRuntimeConfig()?.ui.hideDockOnClose !== false;
}

function applyLoginItemSetting(openAtLogin: boolean) {
  app.setLoginItemSettings({ openAtLogin });
}

async function openConfigFolder() {
  const status = serviceManager?.getStatus();
  if (!status) return;
  await shell.showItemInFolder(status.configPath);
}

async function quitApp() {
  isQuitting = true;
  await serviceManager?.stop();
  app.quit();
}

function buildTrayTooltip(status: ServiceStatus | undefined) {
  if (!status) {
    return "Claude Adapter GUI";
  }
  const state = status.running ? "运行中" : "已停止";
  return `Claude Adapter GUI\n服务状态：${state}\n${status.baseUrl}`;
}

function buildBaseUrlMenuItems(status: ServiceStatus | undefined, fallbackBaseUrl: string) {
  const urls = Array.from(new Set([...(status?.localAccessUrls || []), fallbackBaseUrl]));
  return urls.map((url) => ({
    label: url,
    click: () => {
      clipboard.writeText(url);
    }
  }));
}

function buildModelRouteMenuItems(models: ModelConfig[]) {
  if (models.length === 0) {
    return [
      {
        label: "暂无模型映射",
        enabled: false
      }
    ];
  }

  return models.map((model) => ({
    type: "checkbox" as const,
    label: `${model.localModelId} -> ${model.remoteModelId} (${model.remoteBaseUrl})`,
    checked: model.enabled !== false,
    click: async () => {
      await toggleModelRoute(model.localModelId);
    }
  }));
}

async function toggleModelRoute(localModelId: string) {
  const config = serviceManager?.getRuntimeConfig();
  if (!config) return;

  await serviceManager?.saveConfig({
    models: config.models.map((model) => ({
      ...model,
      enabled: model.localModelId === localModelId ? model.enabled === false : model.enabled
    }))
  });
  refreshTrayMenu();
  mainWindow?.webContents.send("service:changed", serviceManager?.getStatus());
}

app.on("before-quit", async (event) => {
  if (!isQuitting) {
    event.preventDefault();
    await quitApp();
  }
});

bootstrap().catch((error) => {
  console.error(error);
  app.quit();
});
