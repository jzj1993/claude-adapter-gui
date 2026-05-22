/*
文件说明: 声明渲染进程可访问的 Electron preload API 类型。
对应文档: Electron + Vite GUI implementation plan
*/
import type { ClaudeAdapterApi } from "../main/preload";

declare global {
  interface Window {
    claudeAdapter: ClaudeAdapterApi;
  }
}
