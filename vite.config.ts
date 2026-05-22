/*
文件说明: 配置 Vite 渲染进程构建，输出 Electron 主进程加载的静态页面。
对应文档: Electron + Vite GUI implementation plan
*/
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/renderer",
  base: "./",
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
});
