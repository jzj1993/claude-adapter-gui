/*
文件说明: 定义主进程、代理服务和渲染进程共享的数据结构。
对应文档: Electron + Vite GUI implementation plan
*/
export type RemoteProtocol = "anthropic" | "openai";

export type ModelConfig = {
  localModelId: string;
  remoteModelId: string;
  remoteBaseUrl: string;
  remoteApiKey: string;
  remoteProtocol: RemoteProtocol;
  enabled: boolean;
};

export type ImageModelConfig = {
  id: string;
  remoteModelId: string;
  remoteBaseUrl: string;
  remoteApiKey: string;
  enabled: boolean;
};

export type RuntimeConfig = {
  configPath: string;
  listen: {
    host: string;
    port: number;
  };
  ui: {
    hideDockOnClose: boolean;
    launchAtLogin: boolean;
    startHiddenToTray: boolean;
    autoStartProxy: boolean;
  };
  debug: boolean;
  models: ModelConfig[];
  imageModels: ImageModelConfig[];
};

export type PublicModelConfig = ModelConfig & {
  hasApiKey: boolean;
};

export type PublicConfig = {
  configured: boolean;
  configPath: string;
  error: string | null;
  host: string;
  port: number;
  hideDockOnClose: boolean;
  launchAtLogin: boolean;
  startHiddenToTray: boolean;
  autoStartProxy: boolean;
  debug: boolean;
  localBaseUrl: string;
  models: PublicModelConfig[];
};

export type WebModelInput = Partial<ModelConfig> & {
  originalLocalModelId?: string;
};

export type SaveConfigInput = {
  host?: string;
  port?: number;
  hideDockOnClose?: boolean;
  launchAtLogin?: boolean;
  startHiddenToTray?: boolean;
  autoStartProxy?: boolean;
  debug?: boolean;
  models?: WebModelInput[];
};

export type ModelRoute = {
  source: string;
  remoteModelId: string;
  remoteBaseUrl: string;
  remoteApiKey: string;
  remoteProtocol: RemoteProtocol;
};

export type ServiceStatus = {
  running: boolean;
  host: string;
  port: number;
  configPath: string;
  baseUrl: string;
  localAccessUrls?: string[] | null;
  error: {
    code?: string;
    message: string;
  } | null;
};
