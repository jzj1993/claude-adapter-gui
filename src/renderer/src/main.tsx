/*
文件说明: React 渲染进程入口，挂载桌面代理配置应用。
对应文档: Electron + Vite GUI implementation plan
*/
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
