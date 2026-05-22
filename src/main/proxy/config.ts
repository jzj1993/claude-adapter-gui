/*
文件说明: 读取、规范化并保存本地代理配置，是 HTTP 代理与 Electron GUI 共享的配置真源。
参考资料: claude-client-adapter src/config.js
对应文档: Electron + Vite GUI implementation plan
*/
import fs from "node:fs/promises";
import path from "node:path";
import type { PublicConfig, SaveConfigInput, RuntimeConfig, ModelRoute, WebModelInput, ModelConfig } from "../../shared/types";

export const DEFAULT_CONFIG_PATH = "config.json";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 18787;
export const LOCAL_BASE_HOST = "127.0.0.1";

export async function loadConfig(configPath: string): Promise<RuntimeConfig> {
  const resolvedPath = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  let raw: string;

  try {
    raw = await fs.readFile(resolvedPath, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      const notFound = new Error(`找不到配置文件：${resolvedPath}`) as NodeJS.ErrnoException;
      notFound.code = "ENOENT";
      throw notFound;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件不是合法的 JSON：${resolvedPath}。${error instanceof Error ? error.message : String(error)}`);
  }

  return normalizeConfig(parsed, resolvedPath);
}

export async function loadOptionalConfig(configPath: string): Promise<{
  config: RuntimeConfig | null;
  configPath: string;
  error: Error | null;
}> {
  const resolvedPath = path.resolve(configPath || DEFAULT_CONFIG_PATH);

  try {
    return {
      config: await loadConfig(resolvedPath),
      configPath: resolvedPath,
      error: null
    };
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      await writeStarterConfig(resolvedPath);
      return {
        config: null,
        configPath: resolvedPath,
        error: new Error("已自动创建 config.json，请在界面里填写远程模型信息。")
      };
    }

    return {
      config: null,
      configPath: resolvedPath,
      error: error instanceof Error ? error : new Error(String(error))
    };
  }
}

export async function saveWebConfig(
  configPath: string,
  input: SaveConfigInput,
  currentConfig: RuntimeConfig | null
): Promise<RuntimeConfig> {
  const resolvedPath = path.resolve(configPath || DEFAULT_CONFIG_PATH);
  const models = normalizeWebModelInputs(input.models, currentConfig);

  const rawConfig = {
    listen: {
      host: input.host || currentConfig?.listen.host || DEFAULT_HOST,
      port: Number(input.port || currentConfig?.listen.port || DEFAULT_PORT)
    },
    ui: {
      hideDockOnClose:
        typeof input.hideDockOnClose === "boolean" ? input.hideDockOnClose : currentConfig?.ui.hideDockOnClose !== false,
      launchAtLogin: typeof input.launchAtLogin === "boolean" ? input.launchAtLogin : currentConfig?.ui.launchAtLogin === true,
      startHiddenToTray:
        typeof input.startHiddenToTray === "boolean" ? input.startHiddenToTray : currentConfig?.ui.startHiddenToTray === true,
      autoStartProxy: typeof input.autoStartProxy === "boolean" ? input.autoStartProxy : currentConfig?.ui.autoStartProxy !== false
    },
    debug: typeof input.debug === "boolean" ? input.debug : currentConfig?.debug === true,
    models: models.map((model) => ({
      localModelId: model.localModelId,
      remoteModelId: model.remoteModelId,
      remoteBaseUrl: model.remoteBaseUrl,
      remoteApiKey: model.remoteApiKey,
      remoteProtocol: model.remoteProtocol,
      enabled: model.enabled
    })),
    imageModels: currentConfig?.imageModels || []
  };

  const normalized = normalizeConfig(rawConfig, resolvedPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, `${JSON.stringify(rawConfig, null, 2)}\n`, "utf8");
  return normalized;
}

export function publicConfig(config: RuntimeConfig | null, configPath: string, error: Error | null): PublicConfig {
  const models = publicModelConfigs(config);
  return {
    configured: Boolean(config && models.some((model) => model.enabled !== false)),
    configPath,
    error: error ? error.message : null,
    host: config?.listen.host || DEFAULT_HOST,
    port: config?.listen.port || DEFAULT_PORT,
    hideDockOnClose: config?.ui.hideDockOnClose !== false,
    launchAtLogin: config?.ui.launchAtLogin === true,
    startHiddenToTray: config?.ui.startHiddenToTray === true,
    autoStartProxy: config?.ui.autoStartProxy !== false,
    debug: config?.debug === true,
    localBaseUrl: `http://${LOCAL_BASE_HOST}:${config?.listen.port || DEFAULT_PORT}`,
    models
  };
}

export function normalizeConfig(input: unknown, configPath: string): RuntimeConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("配置文件内容必须是一个 JSON 对象。");
  }

  const raw = input as Record<string, unknown>;
  const listen = isRecord(raw.listen) ? raw.listen : {};
  const ui = isRecord(raw.ui) ? raw.ui : {};
  const logging = isRecord(raw.logging) ? raw.logging : {};
  const port = Number(listen.port || DEFAULT_PORT);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("配置字段 listen.port 必须是有效端口号。");
  }

  return {
    configPath,
    listen: {
      host: typeof listen.host === "string" && listen.host ? listen.host : DEFAULT_HOST,
      port
    },
    ui: {
      hideDockOnClose: ui.hideDockOnClose !== false,
      launchAtLogin: ui.launchAtLogin === true,
      startHiddenToTray: ui.startHiddenToTray === true,
      autoStartProxy: ui.autoStartProxy !== false
    },
    debug: raw.debug === true || logging.debug === true,
    models: normalizeModels(raw.models || []),
    imageModels: normalizeImageModels(raw.imageModels || [])
  };
}

export function resolveModel(config: RuntimeConfig, requestedModel: string): ModelRoute {
  const enabledModels = config.models.filter((model) => model.enabled !== false);
  const mapping = enabledModels.find((model) => model.localModelId === requestedModel) || enabledModels[0];
  if (!mapping) {
    throw new Error("还没有配置任何模型映射。");
  }

  return {
    source: mapping.localModelId,
    remoteModelId: mapping.remoteModelId,
    remoteBaseUrl: mapping.remoteBaseUrl,
    remoteApiKey: modelApiKey(mapping),
    remoteProtocol: mapping.remoteProtocol || "anthropic"
  };
}

export function resolveImageModel(config: RuntimeConfig, modelId: string | undefined) {
  const imageModels = config.imageModels || [];
  const match = imageModels.find((model) => model.id === modelId) || imageModels[0];
  if (!match) {
    throw Object.assign(new Error("没有配置任何图片生成模型。"), { statusCode: 503 });
  }
  return match;
}

export async function writeStarterConfig(configPath: string): Promise<void> {
  const starterConfig = {
    listen: {
      host: DEFAULT_HOST,
      port: DEFAULT_PORT
    },
    ui: {
      hideDockOnClose: true,
      launchAtLogin: false,
      startHiddenToTray: false,
      autoStartProxy: true
    },
    debug: false,
    models: [],
    imageModels: []
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(starterConfig, null, 2)}\n`, "utf8");
}

function publicModelConfigs(config: RuntimeConfig | null) {
  if (!config) {
    return [];
  }

  return config.models.map((mapping) => ({
    localModelId: mapping.localModelId,
    remoteBaseUrl: mapping.remoteBaseUrl || "",
    remoteModelId: mapping.remoteModelId,
    remoteApiKey: modelApiKey(mapping),
    remoteProtocol: mapping.remoteProtocol || "anthropic",
    hasApiKey: Boolean(modelApiKey(mapping)),
    enabled: mapping.enabled
  }));
}

function normalizeWebModelInputs(modelInputs: WebModelInput[] | undefined, currentConfig: RuntimeConfig | null): ModelConfig[] {
  if (!Array.isArray(modelInputs)) {
    throw new Error("模型配置格式不正确。");
  }

  const models: ModelConfig[] = [];
  const seen = new Set<string>();

  for (const input of modelInputs) {
    const localModelId = String(input.localModelId || "").trim();
    let remoteBaseUrl = String(input.remoteBaseUrl || "").trim();
    let remoteModelId = String(input.remoteModelId || "").trim();
    const remoteApiKey = String(input.remoteApiKey || "").trim();
    const enabled = input.enabled !== false;
    const remoteProtocol: ModelConfig["remoteProtocol"] = input.remoteProtocol === "openai" ? "openai" : "anthropic";

    if (looksLikeHttpUrl(remoteModelId) && !looksLikeHttpUrl(remoteBaseUrl)) {
      [remoteBaseUrl, remoteModelId] = [remoteModelId, remoteBaseUrl];
    }

    if (!localModelId) {
      throw new Error("请填写本地模型名。");
    }
    if (seen.has(localModelId)) {
      throw new Error(`模型名重复：${localModelId}`);
    }
    if (!remoteBaseUrl) {
      throw new Error(`请填写 ${localModelId} 的 remoteBaseUrl。`);
    }
    if (!looksLikeHttpUrl(remoteBaseUrl)) {
      throw new Error(`模型 "${localModelId}" 的 remoteBaseUrl 必须以 http:// 或 https:// 开头。`);
    }
    if (!remoteModelId) {
      throw new Error(`请填写 ${localModelId} 的 remoteModelId。`);
    }

    seen.add(localModelId);
    models.push({
      localModelId,
      remoteBaseUrl: stripTrailingSlash(remoteBaseUrl),
      remoteModelId,
      remoteApiKey,
      remoteProtocol,
      enabled
    });
  }

  return models;
}

function normalizeModels(models: unknown): ModelConfig[] {
  if (!Array.isArray(models)) {
    throw new Error("配置字段 models 必须是数组。");
  }

  const normalized: ModelConfig[] = [];
  const seen = new Set<string>();

  for (const value of models) {
    if (!isRecord(value)) {
      throw new Error("models 数组里的每一项都必须是对象。");
    }

    const localModelId = String(value.localModelId || value.source || value.model || "").trim();
    if (!localModelId) {
      throw new Error("models 数组里的每一项都必须包含 localModelId。");
    }
    if (seen.has(localModelId)) {
      throw new Error(`模型名重复：${localModelId}`);
    }

    let remoteModelId = typeof value.remoteModelId === "string" ? value.remoteModelId.trim() : "";
    let remoteBaseUrl = typeof value.remoteBaseUrl === "string" ? value.remoteBaseUrl.trim() : "";

    if (looksLikeHttpUrl(remoteModelId) && !looksLikeHttpUrl(remoteBaseUrl)) {
      [remoteBaseUrl, remoteModelId] = [remoteModelId, remoteBaseUrl];
    }
    if (!remoteModelId) {
      throw new Error(`模型 "${localModelId}" 的映射必须包含 remoteModelId。`);
    }
    if (!remoteBaseUrl || !looksLikeHttpUrl(remoteBaseUrl)) {
      throw new Error(`模型 "${localModelId}" 的 remoteBaseUrl 必须以 http:// 或 https:// 开头。`);
    }

    seen.add(localModelId);
    normalized.push({
      localModelId,
      remoteModelId,
      remoteBaseUrl: stripTrailingSlash(remoteBaseUrl),
      remoteApiKey: typeof value.remoteApiKey === "string" ? value.remoteApiKey : "",
      remoteProtocol: value.remoteProtocol === "openai" ? "openai" : "anthropic",
      enabled: value.enabled !== false
    });
  }

  return normalized;
}

function normalizeImageModels(imageModels: unknown) {
  if (!Array.isArray(imageModels)) {
    return [];
  }

  return imageModels
    .filter(isRecord)
    .map((model) => ({
      id: String(model.id || "").trim(),
      remoteModelId: String(model.remoteModelId || model.id || "").trim(),
      remoteBaseUrl: stripTrailingSlash(String(model.remoteBaseUrl || "").trim()),
      remoteApiKey: String(model.remoteApiKey || "").trim(),
      enabled: model.enabled !== false
    }))
    .filter((model) => model.id && model.remoteBaseUrl && model.enabled !== false);
}

function modelApiKey(mapping: { remoteApiKey?: string }) {
  return Object.prototype.hasOwnProperty.call(mapping, "remoteApiKey") ? mapping.remoteApiKey || "" : "";
}

function stripTrailingSlash(url: string) {
  return url.replace(/\/+$/, "");
}

function looksLikeHttpUrl(value: unknown) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
}
