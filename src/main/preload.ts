/*
文件说明: 通过安全的 contextBridge 向渲染进程暴露配置、服务控制和应用辅助 IPC。
对应文档: Electron + Vite GUI implementation plan
*/
import { contextBridge, ipcRenderer } from "electron";
import type { PublicConfig, SaveConfigInput, ServiceStatus } from "../shared/types";

const api = {
  service: {
    getStatus: () => ipcRenderer.invoke("service:getStatus") as Promise<ServiceStatus>,
    start: () => ipcRenderer.invoke("service:start") as Promise<ServiceStatus>,
    stop: () => ipcRenderer.invoke("service:stop") as Promise<ServiceStatus>,
    onChanged: (callback: (status: ServiceStatus) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, status: ServiceStatus) => callback(status);
      ipcRenderer.on("service:changed", listener);
      return () => ipcRenderer.off("service:changed", listener);
    }
  },
  config: {
    get: () => ipcRenderer.invoke("config:get") as Promise<PublicConfig>,
    save: (input: SaveConfigInput) => ipcRenderer.invoke("config:save", input) as Promise<PublicConfig>
  },
  app: {
    openConfigFolder: () => ipcRenderer.invoke("app:openConfigFolder") as Promise<void>
  }
};

contextBridge.exposeInMainWorld("claudeAdapter", api);

export type ClaudeAdapterApi = typeof api;
