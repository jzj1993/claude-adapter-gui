/*
文件说明: 创建本地 Express 代理应用和 HTTP server，暴露配置、健康检查与模型转发接口。
参考资料: claude-client-adapter src/server.js
对应文档: Electron + Vite GUI implementation plan
*/
import express from "express";
import http from "node:http";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  loadOptionalConfig,
  publicConfig,
  resolveImageModel,
  resolveModel,
  saveWebConfig
} from "./config";
import { forwardAnthropicRequest, forwardImageRequest } from "./forwarder";
import { createLogger } from "./logger";
import type { RuntimeConfig, SaveConfigInput } from "../../shared/types";

export type ConfigState = {
  configPath: string;
  getConfig(): RuntimeConfig | null;
  getError(): Error | null;
  getLogger(): ReturnType<typeof createLogger>;
  save(input: SaveConfigInput): Promise<RuntimeConfig>;
};

export async function createConfigState(configPath: string): Promise<ConfigState> {
  const loaded = await loadOptionalConfig(configPath);
  let currentConfig = loaded.config;
  let currentError = loaded.error;

  return {
    configPath: loaded.configPath,
    getConfig() {
      return currentConfig;
    },
    getError() {
      return currentError;
    },
    getLogger() {
      return createLogger({ debug: currentConfig?.debug });
    },
    async save(input) {
      currentConfig = await saveWebConfig(loaded.configPath, input, currentConfig);
      currentError = null;
      return currentConfig;
    }
  };
}

export function createServer(state: ConfigState): http.Server {
  return http.createServer(createApp(state));
}

export function createApp(state: ConfigState) {
  const app = express();

  app.get("/api/config", localOnly, (req, res) => {
    res.json(publicConfig(state.getConfig(), state.configPath, state.getError()));
  });

  app.post("/api/config", localOnly, express.json({ limit: "1mb" }), async (req, res, next) => {
    try {
      const saved = await state.save(req.body || {});
      await state.getLogger().debug("配置已保存", {
        modelCount: saved.models.length,
        enabledModelCount: saved.models.filter((model) => model.enabled !== false).length
      });
      res.json({ ok: true, config: publicConfig(saved, state.configPath, null) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", (req, res) => {
    const config = state.getConfig();
    res.json({
      ok: true,
      configured: Boolean(config),
      models: config?.models.filter((model) => model.enabled !== false).map((model) => model.localModelId) || [],
      imageModels: config?.imageModels.map((model) => model.id) || []
    });
  });

  app.post("/openai/v1/images/generations", express.json({ limit: "10mb" }), async (req, res, next) => {
    const config = state.getConfig();
    if (!config) {
      res.status(503).json({ error: { type: "not_configured_error", message: "llm-model-forward 还没有完成配置。" } });
      return;
    }

    try {
      const body = req.body || {};
      const imageRoute = resolveImageModel(config, body.model);
      await forwardImageRequest(res, imageRoute, body, state.getLogger());
    } catch (error) {
      next(error);
    }
  });

  app.get("/openai/v1/models", (req, res) => {
    const imageModels = (state.getConfig()?.imageModels || []).map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "openai"
    }));
    res.json({ object: "list", data: imageModels });
  });

  app.all(/^\/anthropic(\/.*)?$/, async (req, res, next) => {
    const config = state.getConfig();
    if (!config) {
      res.status(503).json({
        type: "error",
        error: {
          type: "not_configured_error",
          message: "llm-model-forward 还没有完成配置。请打开应用填写并保存配置。"
        }
      });
      return;
    }

    try {
      const remotePath = stripAnthropicPrefix(req.originalUrl || req.url || req.path);
      await forwardAnthropicRequest(req, res, config, remotePath, resolveModel, state.getLogger());
    } catch (error) {
      await state.getLogger().debug("转发失败", {
        method: req.method,
        path: req.originalUrl || req.url || req.path,
        error: error instanceof Error ? error.message : String(error),
        statusCode: hasStatusCode(error) ? error.statusCode : 502
      });
      next(error);
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      type: "error",
      error: {
        type: "not_found_error",
        message: `没有找到接口：${req.method} ${req.path}`
      }
    });
  });

  app.use((error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    res.status(hasStatusCode(error) ? error.statusCode : 502).json({
      type: "error",
      error: {
        type: "api_error",
        message: error instanceof Error ? error.message : String(error)
      }
    });
  });

  return app;
}

export function stripAnthropicPrefix(url: string): string {
  const withoutPrefix = url.replace(/^\/anthropic(?=\/|$)/, "");
  return withoutPrefix || "/";
}

export function defaultListen() {
  return { host: DEFAULT_HOST, port: DEFAULT_PORT };
}

function localOnly(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!isLocalRequest(req)) {
    res.status(403).json({ ok: false, error: "配置接口只允许本机访问。" });
    return;
  }
  next();
}

function isLocalRequest(req: express.Request) {
  const address = req.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function hasStatusCode(error: unknown): error is { statusCode: number } {
  return Boolean(error && typeof error === "object" && "statusCode" in error && typeof (error as { statusCode?: unknown }).statusCode === "number");
}
