/*
文件说明: 管理本地代理 HTTP 服务的配置状态、启动停止生命周期和端口错误呈现。
对应文档: Electron + Vite GUI implementation plan
*/
import type http from "node:http";
import os from "node:os";
import { createConfigState, createServer } from "./proxy/server";
import type { ConfigState } from "./proxy/server";
import { DEFAULT_HOST, DEFAULT_PORT, LOCAL_BASE_HOST, publicConfig } from "./proxy/config";
import type { PublicConfig, RuntimeConfig, SaveConfigInput, ServiceStatus } from "../shared/types";

export class ProxyServiceManager {
  private readonly configPath: string;
  private state: ConfigState | null = null;
  private server: http.Server | null = null;
  private status: ServiceStatus;

  constructor(configPath: string) {
    this.configPath = configPath;
    this.status = {
      running: false,
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      configPath,
      baseUrl: `http://${LOCAL_BASE_HOST}:${DEFAULT_PORT}/anthropic`,
      localAccessUrls: null,
      error: null
    };
  }

  async start(): Promise<ServiceStatus> {
    if (this.server && this.status.running) {
      return this.getStatus();
    }

    this.state = await createConfigState(this.configPath);
    const config = this.state.getConfig();
    const listen = config?.listen || { host: DEFAULT_HOST, port: DEFAULT_PORT };
    const server = createServer(this.state);

    try {
      await listenServer(server, listen.host, listen.port);
    } catch (error) {
      this.server = null;
      this.status = {
        running: false,
        host: listen.host,
        port: listen.port,
        configPath: this.state.configPath,
        baseUrl: `http://${LOCAL_BASE_HOST}:${listen.port}/anthropic`,
        localAccessUrls: null,
        error: normalizeListenError(error, listen.port)
      };
      return this.getStatus();
    }

    this.server = server;
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : listen.port;
    const host = typeof address === "object" && address ? address.address : listen.host;
    const baseUrl = `http://${LOCAL_BASE_HOST}:${port}/anthropic`;
    const localAccessUrls = buildLocalAccessUrls(host, port);
    this.status = {
      running: true,
      host,
      port,
      configPath: this.state.configPath,
      baseUrl,
      localAccessUrls,
      error: null
    };

    const health = await verifyHealth(host, port);
    if (!health.ok) {
      await this.stop();
      this.status = {
        running: false,
        host,
        port,
        configPath: this.state.configPath,
        baseUrl,
        localAccessUrls,
        error: {
          code: "HEALTHCHECK_FAILED",
          message: `代理服务已监听端口 ${port}，但健康检查失败：${health.message}`
        }
      };
    }

    return this.getStatus();
  }

  async stop(): Promise<ServiceStatus> {
    if (!this.server) {
      this.status = { ...this.status, running: false };
      return this.getStatus();
    }

    const server = this.server;
    this.server = null;
    await closeServer(server);
    this.status = { ...this.status, running: false, error: null };
    return this.getStatus();
  }

  getStatus(): ServiceStatus {
    return {
      ...this.status,
      error: this.status.error ? { ...this.status.error } : null
    };
  }

  getRuntimeConfig(): RuntimeConfig | null {
    return this.state?.getConfig() || null;
  }

  async getConfig(): Promise<PublicConfig> {
    await this.ensureState();
    return publicConfig(this.state?.getConfig() || null, this.state?.configPath || this.configPath, this.state?.getError() || null);
  }

  async saveConfig(input: SaveConfigInput): Promise<PublicConfig> {
    await this.ensureState();
    if (!this.state) {
      throw new Error("代理配置状态尚未初始化。");
    }
    const saved = await this.state.save(input);
    const previousPort = this.status.port;
    const previousHost = this.status.host;
    this.status = {
      ...this.status,
      host: saved.listen.host,
      port: saved.listen.port,
      configPath: this.state.configPath,
      baseUrl: `http://${LOCAL_BASE_HOST}:${saved.listen.port}/anthropic`,
      localAccessUrls: buildLocalAccessUrls(saved.listen.host, saved.listen.port)
    };

    if (this.server && (saved.listen.port !== previousPort || saved.listen.host !== previousHost)) {
      await this.stop();
      await this.start();
    }

    return publicConfig(saved, this.state.configPath, null);
  }

  private async ensureState() {
    if (!this.state) {
      this.state = await createConfigState(this.configPath);
      const config = this.state.getConfig();
      if (config) {
        this.status = {
          ...this.status,
          host: config.listen.host,
          port: config.listen.port,
          configPath: this.state.configPath,
          baseUrl: `http://${LOCAL_BASE_HOST}:${config.listen.port}/anthropic`,
          localAccessUrls: buildLocalAccessUrls(config.listen.host, config.listen.port)
        };
      }
    }
  }
}

function listenServer(server: http.Server, host: string, port: number) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function normalizeListenError(error: unknown, port: number) {
  const code = error && typeof error === "object" && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
  if (code === "EADDRINUSE") {
    return {
      code,
      message: `端口 ${port} 已被占用。请打开设置修改端口，或关闭占用该端口的程序。`
    };
  }

  return {
    code,
    message: error instanceof Error ? error.message : String(error)
  };
}

function buildLocalAccessUrls(host: string, port: number) {
  const urls = [`http://127.0.0.1:${port}/anthropic`];
  if (host !== "0.0.0.0" && host !== "::") {
    return urls;
  }

  const lanIps = getLanIps();
  for (const ip of lanIps) {
    urls.push(`http://${ip}:${port}/anthropic`);
  }
  return urls;
}

function getLanIps() {
  const interfaces = os.networkInterfaces();
  const ips = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal && isPrivateLanIpv4(entry.address)) {
        ips.add(entry.address);
      }
    }
  }
  return Array.from(ips);
}

export function isPrivateLanIpv4(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first, second] = parts;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

async function verifyHealth(host: string, port: number) {
  const healthHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  try {
    const response = await fetch(`http://${healthHost}:${port}/health`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) {
      return { ok: false, message: `HTTP ${response.status}` };
    }
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) {
      return { ok: false, message: "响应内容不是有效健康状态" };
    }
    return { ok: true, message: null };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}
