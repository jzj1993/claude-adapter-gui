/*
文件说明: 为代理请求提供可选调试日志，并在输出前隐藏密钥类字段。
参考资料: claude-client-adapter src/logger.js
对应文档: Electron + Vite GUI implementation plan
*/
export type ProxyLogger = {
  debug(message: string, details?: Record<string, unknown>): Promise<void>;
};

export function createLogger(options: { debug?: boolean } = {}): ProxyLogger {
  return {
    async debug(message, details = {}) {
      if (!options.debug) {
        return;
      }
      console.log(`[proxy] ${message}`, redact(details));
    }
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/key|authorization|token|secret/i.test(key)) {
      redacted[key] = child ? "[REDACTED]" : child;
    } else {
      redacted[key] = redact(child);
    }
  }
  return redacted;
}
