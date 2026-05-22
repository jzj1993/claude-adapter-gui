# Claude Adapter GUI

基于 [welovesuzhou/claude-client-adapter](https://github.com/welovesuzhou/claude-client-adapter) 的桌面 GUI 版本。应用在本机启动代理服务，将 Claude / Anthropic 客户端的请求转发至已配置的远程模型服务。

请求链路如下：

`Claude / Anthropic 客户端 -> 本地代理 -> 远程模型服务`

该项目将模型名、Base URL、API Key、协议类型、端口等配置集中于桌面界面统一管理。

## 功能概览

- 本地模型名到远程模型名的映射
- 远程 Base URL 配置
- 远程 API Key 配置
- 远程协议类型选择：`anthropic` 或 `openai`
- 本地代理的启动与停止
- 监听地址与端口配置
- 开机自启、启动后隐藏到托盘、关闭窗口隐藏 Dock 图标
- 局域网访问开关
- 图片生成接口转发
- 当前 Base URL 与服务状态显示

## 请求转发流程

1. 在界面中添加一条模型映射。
2. 每条映射包含以下字段：
   - 本地模型名 `localModelId`
   - 远程模型名 `remoteModelId`
   - 远程地址 `remoteBaseUrl`
   - 远程密钥 `remoteApiKey`
   - 远程协议 `remoteProtocol`
3. 客户端将请求发送至本地代理地址，例如：

  ```text
  http://127.0.0.1:18787/anthropic
  ```

4. 代理根据本地模型名匹配对应映射。
5. 代理将请求转发至远程 `remoteBaseUrl`。
6. 当远程后端为 OpenAI 兼容接口时，代理执行必要的协议转换。

请求指定模型名匹配失败时，使用第一条已启用的映射。

## 安装与使用

安装包通过 GitHub Releases 提供。

Release 地址：[GitHub Releases](https://github.com/jzj1993/claude-adapter-gui/releases)

安装完成后，按以下步骤配置：

1. 打开应用，确认代理服务是否运行。
2. 点击“新增”，添加一条模型映射。
3. 填写本地模型名。
4. 填写远程模型名、远程 Base URL、远程 API Key。
5. 选择远程协议是 `anthropic` 还是 `openai`。
6. 保存后，把 Claude 或 Anthropic 客户端的 Base URL 指向本地代理地址。

默认本地地址是：

`http://127.0.0.1:18787/anthropic`

开启“允许局域网访问”后，界面显示本机入口及探测到的局域网 IPv4 入口。可用入口在界面中标明。

## 配置说明

### 设置界面推荐配置

如果主要在本机使用，建议保持端口为 `18787`，并关闭 `允许局域网访问`。这样代理只对本机开放，路径最简单。

如果希望应用常驻后台，建议同时开启 `启动后自动启动代理服务` 和 `启动后默认隐藏到状态栏`；在 macOS 上也可以按需开启 `关闭窗口时隐藏 Dock 图标`。

`允许局域网访问` 默认不必开启，只有需要让同一局域网里的设备访问这台机器时再打开。`调试日志` 也建议只在排障时开启。

映射项在设置页里单独添加，每条映射填写本地模型名、远程模型名、远程 Base URL、远程 API Key 和远程协议即可。`anthropic` 适合远程就是 Anthropic 风格接口，`openai` 适合远程是 OpenAI 兼容接口的情况。

### Claude 客户端配置

- Base URL：见上方
- API Key：任意填写，转发时实际会使用表格里对应行的密钥
- 模型名：填写你在客户端里要使用的本地模型名，对应应用里配置的 `localModelId`

## 常用命令

本地运行、调试与打包命令如下：

```bash
npm install
npm run dev
npm run build
npm run start
npm run dist
npm run test
```

环境要求：

- Node.js 20+
- npm
