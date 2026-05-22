/*
文件说明: 执行本地代理到远程模型服务的请求转发、鉴权头替换和流式响应透传。
参考资料: claude-client-adapter src/forwarder.js
对应文档: Electron + Vite GUI implementation plan
*/
import type { IncomingMessage, ServerResponse } from "node:http";
import { anthropicToOpenAI, openAIToAnthropic, pipeOpenAIStreamAsAnthropic } from "./openai-adapter";
import type { RuntimeConfig, ModelRoute } from "../../shared/types";
import type { ProxyLogger } from "./logger";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

const AUTH_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);
const MB = 1024 * 1024;
const MAX_JSON_BODY_BYTES = 500 * MB;

export async function forwardAnthropicRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: RuntimeConfig,
  route: string,
  resolveModel: (config: RuntimeConfig, requestedModel: string) => ModelRoute,
  logger: ProxyLogger
) {
  const contentType = String(req.headers["content-type"] || "");
  const jsonLike = contentType.includes("application/json");

  if (!jsonLike) {
    const modelRoute = resolveDefaultRoute(config);
    if (modelRoute.remoteProtocol === "openai") {
      sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "OpenAI 后端只支持 JSON 请求体。" } });
      return;
    }
    await pipeRemoteResponse(req, res, modelRoute, route, req, logger);
    return;
  }

  const bodyBuffer = await readBody(req, MAX_JSON_BODY_BYTES);
  let body: Record<string, unknown> | null = null;
  let modelRoute = resolveDefaultRoute(config);
  let remoteBody: Buffer = bodyBuffer;

  if (bodyBuffer.length > 0) {
    body = parseJsonBody(bodyBuffer);
    const primaryModelName = typeof body.model === "string" ? body.model : null;

    if (primaryModelName) {
      try {
        modelRoute = resolveModel(config, primaryModelName);
      } catch (error) {
        sendJson(res, 400, {
          type: "error",
          error: { type: "invalid_request_error", message: error instanceof Error ? error.message : String(error) }
        });
        return;
      }
    } else {
      const modelNames = collectModelNames(body);
      if (modelNames.length > 0) {
        try {
          modelRoute = resolveModel(config, modelNames[0]);
        } catch (error) {
          sendJson(res, 400, {
            type: "error",
            error: { type: "invalid_request_error", message: error instanceof Error ? error.message : String(error) }
          });
          return;
        }
      }
    }

    const allModelNames = collectModelNames(body);
    if (allModelNames.length > 0) {
      const modelMap = buildModelMap(config, allModelNames, modelRoute, resolveModel);
      remoteBody = Buffer.from(JSON.stringify(rewriteModelNames(body, modelMap)));
    }
  }

  if (modelRoute.remoteProtocol === "openai") {
    await forwardAnthropicToOpenAI(res, modelRoute, body || {}, logger);
    return;
  }

  await pipeRemoteResponse(req, res, modelRoute, route, remoteBody, logger);
}

export async function forwardImageRequest(
  res: ServerResponse,
  imageRoute: { remoteModelId: string; remoteBaseUrl: string; remoteApiKey: string },
  parsedBody: Record<string, unknown>,
  logger: ProxyLogger
) {
  const body = { ...(parsedBody || {}), model: imageRoute.remoteModelId };
  const remoteUrl = `${imageRoute.remoteBaseUrl}/v1/images/generations`;

  await logger.debug("转发图片生成请求", { remoteUrl, model: imageRoute.remoteModelId });

  const remoteResponse = await fetch(remoteUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${imageRoute.remoteApiKey}`
    },
    body: JSON.stringify(body)
  });

  await logger.debug("图片生成响应", { status: remoteResponse.status });
  const responseBody = await remoteResponse.text();
  res.setHeader("content-type", "application/json");
  res.writeHead(remoteResponse.status);
  res.end(responseBody);
}

function readBody(req: IncomingMessage, maxBytes = 20 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error("请求体太大。"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJsonBody(bodyBuffer: Buffer): Record<string, unknown> {
  const raw = bodyBuffer.toString("utf8");
  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`请求体不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`), { statusCode: 400 });
  }
}

function buildForwardHeaders(req: IncomingMessage, modelRoute: ModelRoute) {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(req.headers)) {
    const lowerKey = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
      continue;
    }

    if (Array.isArray(value)) {
      headers[lowerKey] = value.join(", ");
    } else if (value !== undefined) {
      headers[lowerKey] = value;
    }
  }

  replaceApiKeyHeader(headers, modelRoute.remoteApiKey);
  return headers;
}

function replaceApiKeyHeader(headers: Record<string, string>, remoteApiKey: string) {
  const originalAuthHeaders: Record<string, boolean> = {};

  for (const headerName of AUTH_HEADERS) {
    if (Object.prototype.hasOwnProperty.call(headers, headerName)) {
      originalAuthHeaders[headerName] = true;
      delete headers[headerName];
    }
  }

  if (!remoteApiKey) {
    return headers;
  }

  if (originalAuthHeaders.authorization) headers.authorization = `Bearer ${remoteApiKey}`;
  if (originalAuthHeaders["x-api-key"]) headers["x-api-key"] = remoteApiKey;
  if (originalAuthHeaders["api-key"]) headers["api-key"] = remoteApiKey;
  return headers;
}

async function forwardAnthropicToOpenAI(
  res: ServerResponse,
  modelRoute: ModelRoute,
  anthropicBody: Record<string, unknown>,
  logger: ProxyLogger
) {
  const isStream = Boolean(anthropicBody.stream);
  const openAIBody = anthropicToOpenAI(anthropicBody, modelRoute.remoteModelId);
  const remoteUrl = `${modelRoute.remoteBaseUrl}/v1/chat/completions`;

  await logger.debug("转发到 OpenAI 后端", {
    method: "POST",
    remoteUrl,
    sourceModel: modelRoute.source,
    targetModel: modelRoute.remoteModelId,
    stream: isStream
  });

  const remoteResponse = await fetch(remoteUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${modelRoute.remoteApiKey}`
    },
    body: JSON.stringify(openAIBody)
  });

  if (!remoteResponse.ok) {
    const errText = await remoteResponse.text().catch(() => "");
    sendJson(res, remoteResponse.status, {
      type: "error",
      error: { type: "api_error", message: `上游 OpenAI 后端返回错误 ${remoteResponse.status}：${errText}` }
    });
    return;
  }

  if (isStream) {
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("x-accel-buffering", "no");
    res.writeHead(200);
    await pipeOpenAIStreamAsAnthropic(remoteResponse.body as ReadableStream<Uint8Array>, res, modelRoute.source);
    res.end();
    return;
  }

  const openAIJson = await remoteResponse.json();
  sendJson(res, 200, openAIToAnthropic(openAIJson as Record<string, any>, modelRoute.source));
}

async function pipeRemoteResponse(
  req: IncomingMessage,
  res: ServerResponse,
  modelRoute: ModelRoute,
  route: string,
  body: IncomingMessage | Buffer,
  logger: ProxyLogger
) {
  const method = String(req.method || "").toUpperCase();
  const remoteBody = method === "GET" || method === "HEAD" ? undefined : body;
  const remoteUrl = `${modelRoute.remoteBaseUrl}${route}`;

  await logger.debug("开始转发请求", {
    method: req.method,
    remoteUrl,
    sourceModel: modelRoute.source,
    targetModel: modelRoute.remoteModelId,
    hasBody: Boolean(remoteBody)
  });

  const remoteResponse = await fetch(remoteUrl, {
    method: req.method,
    headers: buildForwardHeaders(req, modelRoute),
    body: remoteBody as BodyInit | undefined,
    duplex: remoteBody && typeof (remoteBody as IncomingMessage).pipe === "function" ? "half" : undefined,
    redirect: "manual"
  } as RequestInit & { duplex?: "half" });

  copyResponseHeaders(remoteResponse.headers, res);
  res.statusMessage = remoteResponse.statusText || res.statusMessage;
  res.writeHead(remoteResponse.status);

  if (!remoteResponse.body) {
    res.end();
    return;
  }

  try {
    for await (const chunk of remoteResponse.body as any) {
      if (res.destroyed) break;
      res.write(Buffer.from(chunk));
    }
  } catch (error) {
    await logger.debug("读取远程模型响应失败", {
      method: req.method,
      remoteUrl,
      error: error instanceof Error ? error.message : String(error)
    });
    if (!res.destroyed) {
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    }
    return;
  }

  if (!res.destroyed) {
    res.end();
  }
}

function resolveDefaultRoute(config: RuntimeConfig): ModelRoute {
  const mapping = config.models.find((model) => model.enabled !== false);
  if (!mapping) {
    throw Object.assign(new Error("还没有配置任何模型映射。"), { statusCode: 503 });
  }

  return {
    source: mapping.localModelId,
    remoteModelId: mapping.remoteModelId,
    remoteBaseUrl: mapping.remoteBaseUrl,
    remoteApiKey: mapping.remoteApiKey || "",
    remoteProtocol: mapping.remoteProtocol || "anthropic"
  };
}

function copyResponseHeaders(headers: Headers, res: ServerResponse) {
  for (const [key, value] of headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
      continue;
    }
    if (key.toLowerCase() === "set-cookie" && typeof (headers as any).getSetCookie === "function") {
      continue;
    }
    res.setHeader(key, value);
  }

  if (typeof (headers as any).getSetCookie === "function") {
    const cookies = (headers as any).getSetCookie();
    if (cookies.length > 0) {
      res.setHeader("set-cookie", cookies);
    }
  }
}

function collectModelNames(value: unknown, models: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectModelNames(item, models);
    return models;
  }
  if (!value || typeof value !== "object") {
    return models;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "model" && typeof child === "string") {
      models.push(child);
    } else {
      collectModelNames(child, models);
    }
  }
  return models;
}

function buildModelMap(
  config: RuntimeConfig,
  modelNames: string[],
  primaryRoute: ModelRoute,
  resolveModel: (config: RuntimeConfig, requestedModel: string) => ModelRoute
) {
  const modelMap = new Map<string, string>();

  for (const modelName of new Set(modelNames)) {
    let route: ModelRoute;
    try {
      route = resolveModel(config, modelName);
    } catch {
      route = primaryRoute;
    }

    const sameBackend = route.remoteBaseUrl === primaryRoute.remoteBaseUrl && route.remoteApiKey === primaryRoute.remoteApiKey;
    modelMap.set(modelName, sameBackend ? route.remoteModelId : primaryRoute.remoteModelId);
  }

  return modelMap;
}

function rewriteModelNames(value: unknown, modelMap: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteModelNames(item, modelMap));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "model" && typeof child === "string" && modelMap.has(child)) {
      rewritten[key] = modelMap.get(child);
    } else {
      rewritten[key] = rewriteModelNames(child, modelMap);
    }
  }
  return rewritten;
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}
