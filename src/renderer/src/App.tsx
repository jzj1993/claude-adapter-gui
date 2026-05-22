/*
文件说明: 实现模型映射配置、服务启停、状态展示和配置文件入口的桌面 GUI。
对应文档: Electron + Vite GUI implementation plan
*/
import { Check, Eye, EyeOff, FolderOpen, Play, Plus, Settings, Square, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { LOGO_FOREGROUND, LOGO_VIEWBOX, logoMarkPaths } from "../../shared/logo";
import type { PublicConfig, PublicModelConfig, RemoteProtocol, ServiceStatus, WebModelInput } from "../../shared/types";

type DraftModel = WebModelInput & {
  showApiKey?: boolean;
};

type SettingsDraft = {
  host: string;
  port: string;
  hideDockOnClose: boolean;
  launchAtLogin: boolean;
  startHiddenToTray: boolean;
  autoStartProxy: boolean;
  debug: boolean;
};

const emptyDraft: DraftModel = {
  localModelId: "",
  remoteModelId: "",
  remoteBaseUrl: "",
  remoteApiKey: "",
  remoteProtocol: "anthropic",
  enabled: true,
  showApiKey: false
};

const MESSAGE_AUTO_HIDE_MS = 30_000;

export function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [service, setService] = useState<ServiceStatus | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftModel | null>(null);
  const [visibleKeys, setVisibleKeys] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState<{ type: "info" | "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const messageTimerRef = useRef<number | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>({
    host: "127.0.0.1",
    port: "18787",
    hideDockOnClose: true,
    launchAtLogin: false,
    startHiddenToTray: false,
    autoStartProxy: true,
    debug: false
  });

  useEffect(() => {
    void refreshAll();
    return window.claudeAdapter.service.onChanged((status) => {
      setService(status);
      void refreshAll();
    });
  }, []);

  useEffect(() => {
    if (!message) {
      if (messageTimerRef.current !== null) {
        window.clearTimeout(messageTimerRef.current);
        messageTimerRef.current = null;
      }
      return;
    }

    if (messageTimerRef.current !== null) {
      window.clearTimeout(messageTimerRef.current);
    }

    messageTimerRef.current = window.setTimeout(() => {
      setMessage(null);
      messageTimerRef.current = null;
    }, MESSAGE_AUTO_HIDE_MS);

    return () => {
      if (messageTimerRef.current !== null) {
        window.clearTimeout(messageTimerRef.current);
        messageTimerRef.current = null;
      }
    };
  }, [message]);

  const models = config?.models || [];
  const displayedModels = useMemo(() => (editingKey === "__new__" && draft ? [draft, ...models] : models), [draft, editingKey, models]);
  const baseUrl = service?.baseUrl || `${config?.localBaseUrl || "http://127.0.0.1:18787"}/anthropic`;
  const localAccessUrls = service?.localAccessUrls || [];
  const running = service?.running === true;

  function showMessage(nextMessage: { type: "info" | "success" | "error"; text: string } | null) {
    if (messageTimerRef.current !== null) {
      window.clearTimeout(messageTimerRef.current);
      messageTimerRef.current = null;
    }
    setMessage(nextMessage);
  }

  async function refreshAll() {
    try {
      const [nextConfig, nextService] = await Promise.all([
        window.claudeAdapter.config.get(),
        window.claudeAdapter.service.getStatus()
      ]);
      setConfig(nextConfig);
      setService(nextService);
      setSettingsDraft(toSettingsDraft(nextConfig));
      if (nextConfig.error) {
        showMessage({ type: "error", text: nextConfig.error });
      }
    } catch (error) {
      showMessage({ type: "error", text: errorMessage(error) });
    }
  }

  async function toggleService() {
    setBusy(true);
    try {
      const next = running ? await window.claudeAdapter.service.stop() : await window.claudeAdapter.service.start();
      setService(next);
      if (next.error?.code === "EADDRINUSE") {
        openSettings();
      }
      showMessage({
        type: next.error ? "error" : "success",
        text: next.error ? formatServiceError(next.error.message) : next.running ? "代理服务已启动，并已通过健康检查。" : "代理服务已停止。"
      });
    } catch (error) {
      showMessage({ type: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  function addRow() {
    setEditingKey("__new__");
    setDraft({ ...emptyDraft });
  }

  function editRow(model: PublicModelConfig) {
    setEditingKey(model.localModelId);
    setDraft({
      originalLocalModelId: model.localModelId,
      localModelId: model.localModelId,
      remoteModelId: model.remoteModelId,
      remoteBaseUrl: model.remoteBaseUrl,
      remoteApiKey: model.remoteApiKey,
      remoteProtocol: model.remoteProtocol,
      enabled: model.enabled !== false,
      showApiKey: false
    });
  }

  function cancelEdit() {
    setEditingKey(null);
    setDraft(null);
  }

  async function saveEditingRow() {
    if (!draft) return;
    const normalizedDraft = normalizeDraft(draft);
    const validationError = validateDraft(normalizedDraft, models);
    if (validationError) {
      showMessage({ type: "error", text: validationError });
      return;
    }

    const nextModels = [...models];
    const existingIndex = nextModels.findIndex((model) => model.localModelId === normalizedDraft.originalLocalModelId);
    const savedRow = toModelInput(normalizedDraft);

    if (existingIndex >= 0) {
      nextModels[existingIndex] = savedRow as PublicModelConfig;
    } else {
      nextModels.unshift(savedRow as PublicModelConfig);
    }

    const saved = await saveAll(nextModels);
    if (saved) {
      cancelEdit();
    }
  }

  async function deleteRow(localModelId: string) {
    const confirmed = window.confirm(`确定要删除模型映射「${localModelId}」吗？`);
    if (!confirmed) return;

    const saved = await saveAll(models.filter((model) => model.localModelId !== localModelId));
    if (saved && editingKey === localModelId) {
      cancelEdit();
    }
  }

  async function toggleEnabled(localModelId: string) {
    await saveAll(
      models.map((model) => (model.localModelId === localModelId ? { ...model, enabled: model.enabled === false } : model))
    );
  }

  async function saveAll(nextModels: WebModelInput[]) {
    setBusy(true);
    try {
      showMessage({ type: "info", text: "正在保存..." });
      const saved = await window.claudeAdapter.config.save({ models: nextModels });
      const nextService = await window.claudeAdapter.service.getStatus();
      setConfig(saved);
      setService(nextService);
      setSettingsDraft(toSettingsDraft(saved));
      showMessage({ type: "success", text: "配置已保存。新的转发请求会立即生效。" });
      return true;
    } catch (error) {
      showMessage({ type: "error", text: errorMessage(error) });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(field: keyof DraftModel, value: string | boolean) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  function toggleVisibleKey(localModelId: string) {
    setVisibleKeys((current) => {
      const next = new Set(current);
      if (next.has(localModelId)) {
        next.delete(localModelId);
      } else {
        next.add(localModelId);
      }
      return next;
    });
  }

  function openSettings() {
    setSettingsDraft({
      host: config?.host || service?.host || "127.0.0.1",
      port: String(config?.port || service?.port || 18787),
      hideDockOnClose: config?.hideDockOnClose !== false,
      launchAtLogin: config?.launchAtLogin === true,
      startHiddenToTray: config?.startHiddenToTray === true,
      autoStartProxy: config?.autoStartProxy !== false,
      debug: config?.debug === true
    });
    setSettingsOpen(true);
  }

  async function saveSettings() {
    const port = Number(settingsDraft.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      showMessage({ type: "error", text: "端口必须是 1 到 65535 之间的整数。" });
      return;
    }

    setBusy(true);
    try {
      const saved = await window.claudeAdapter.config.save({
        host: settingsDraft.host,
        port,
        hideDockOnClose: settingsDraft.hideDockOnClose,
        launchAtLogin: settingsDraft.launchAtLogin,
        startHiddenToTray: settingsDraft.startHiddenToTray,
        autoStartProxy: settingsDraft.autoStartProxy,
        debug: settingsDraft.debug,
        models
      });
      const nextService = await window.claudeAdapter.service.getStatus();
      setConfig(saved);
      setService(nextService);
      setSettingsDraft(toSettingsDraft(saved));
      setSettingsOpen(false);
      if (nextService.error?.code === "EADDRINUSE") {
        setSettingsOpen(true);
      }
      showMessage({ type: nextService.error ? "error" : "success", text: nextService.error ? formatServiceError(nextService.error.message) : "设置已保存。" });
    } catch (error) {
      showMessage({ type: "error", text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="hero-panel">
        <div className="hero-main">
          <div className={running ? "status-badge status-running" : "status-badge status-stopped"}>
            {running ? "服务状态：运行中" : "服务状态：已停止"}
          </div>
          <div className="brand-row">
            <ProjectLogo />
            <div>
              <p className="eyebrow">Anthropic Proxy</p>
              <h1>CLAUDE CLIENT ADAPTER</h1>
            </div>
          </div>
          <p className="hero-copy">
            配置本地 Claude 模型到远程 Anthropic 或 OpenAI 兼容服务的映射。桌面应用会在本机启动代理服务，并把请求转发到你配置的远程模型。
          </p>
        </div>

        <div className="hero-side">
          <div className="hero-actions">
            <button className={running ? "secondary-button danger-hover" : "primary-button"} onClick={toggleService} disabled={busy}>
              {running ? <Square size={16} /> : <Play size={16} />}
              {running ? "停止服务" : "启动服务"}
            </button>
            <button className="secondary-button" onClick={openSettings}>
              <Settings size={16} />
              设置
            </button>
          </div>
          <p className="hero-side-note">开启局域网访问时，这里会同时列出本机和所有可用局域网入口。</p>
          <InfoTile
            label="Base URL"
            value={baseUrl}
            detail={localAccessUrls.length ? localAccessUrls : undefined}
            mono
          />
          {service?.error ? <div className="error-tile">{service.error.message}</div> : null}
        </div>
      </header>

      <main className="content-panel">
        <div className="section-heading">
          <div>
            <h2>模型映射</h2>
            <p>点击编辑后，该行会直接变成可编辑状态。</p>
          </div>
          <button className="secondary-button" onClick={addRow} disabled={Boolean(editingKey)}>
            <Plus size={16} />
            新增
          </button>
        </div>

        <div className="table-frame">
          <table>
            <thead>
              <tr>
                <th>本地模型名<span>Local Model Id</span></th>
                <th>远程模型名<span>Remote Model Id</span></th>
                <th>远程协议<span>Remote Protocol</span></th>
                <th>远程地址<span>Remote Base Url</span></th>
                <th>远程密钥<span>Remote Api Key</span></th>
                <th className="actions-col">操作<span>Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {displayedModels.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-cell">还没有模型映射</td>
                </tr>
              ) : (
                displayedModels.map((model, index) => {
                  const rowKey = "originalLocalModelId" in model && model.originalLocalModelId ? model.originalLocalModelId : model.localModelId || "__new__";
                  const isNew = editingKey === "__new__" && index === 0;
                  const isEditing = isNew || editingKey === rowKey;
                  const editRowKey = isNew ? "__new__" : rowKey;
                  return isEditing && draft ? (
                    <EditRow key={editRowKey} draft={draft} updateDraft={updateDraft} save={saveEditingRow} cancel={cancelEdit} busy={busy} />
                  ) : (
                    <ViewRow
                      key={rowKey}
                      model={model as PublicModelConfig}
                      visible={visibleKeys.has((model as PublicModelConfig).localModelId)}
                      toggleVisibleKey={toggleVisibleKey}
                      editRow={editRow}
                      deleteRow={deleteRow}
                      toggleEnabled={toggleEnabled}
                      busy={busy}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="helper-copy">Claude 客户端配置：Base URL 见上方；API Key 任意填写，转发时实际会使用表格里对应行的密钥。</p>
      </main>

      {message ? (
        <div className={`message ${message.type}`} role="status" aria-live="polite">
          <span className="message-text">{message.text}</span>
          <button className="message-close" onClick={() => showMessage(null)} title="关闭" aria-label="关闭通知">
            <X size={14} />
          </button>
        </div>
      ) : null}
      {settingsOpen ? (
        <SettingsDialog
          draft={settingsDraft}
          configPath={config?.configPath || service?.configPath || "config.json"}
          busy={busy}
          setDraft={setSettingsDraft}
          save={saveSettings}
          close={() => setSettingsOpen(false)}
        />
      ) : null}
    </div>
  );
}

function InfoTile({
  label,
  value,
  detail,
  mono
}: {
  label: string;
  value: string;
  detail?: string[];
  mono?: boolean;
}) {
  return (
    <div className="info-tile">
      <p>{label}</p>
      {detail?.length ? (
        <div className="info-detail-list">
          <div className="info-detail-group">
            <span className="info-detail-label">本机：</span>
            <strong className={mono ? "mono info-detail-url" : "info-detail-url"}>{detail[0] || "无"}</strong>
          </div>
          {detail.length > 1 ? (
            <div className="info-detail-group">
              <span className="info-detail-label">局域网</span>
              <div className="info-detail-links">
                {detail.slice(1).map((item) => (
                  <strong key={item} className={mono ? "mono info-detail-url" : "info-detail-url"}>
                    {item}
                  </strong>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ProjectLogo() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <svg viewBox={LOGO_VIEWBOX} role="img" dangerouslySetInnerHTML={{ __html: logoMarkPaths(LOGO_FOREGROUND) }} />
    </div>
  );
}

function SettingsDialog({
  draft,
  configPath,
  busy,
  setDraft,
  save,
  close
}: {
  draft: SettingsDraft;
  configPath: string;
  busy: boolean;
  setDraft(next: SettingsDraft): void;
  save(): void;
  close(): void;
}) {
  const localOnly = draft.host === "127.0.0.1";

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h3 id="settings-title">设置</h3>
            <p>调整本地代理的监听方式和配置文件位置。</p>
          </div>
          <button className="icon-button" onClick={close} title="关闭">
            <X size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="setting-field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.launchAtLogin}
                onChange={(event) => setDraft({ ...draft, launchAtLogin: event.target.checked })}
              />
              <span>开机自启</span>
            </label>
            <p className="setting-hint">开启后，保存设置会立即配置系统登录时自动启动此应用。</p>
          </div>

          <div className="setting-field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.startHiddenToTray}
                onChange={(event) => setDraft({ ...draft, startHiddenToTray: event.target.checked })}
              />
              <span>启动后默认隐藏到状态栏</span>
            </label>
            <p className="setting-hint">开启后，下次启动只显示状态栏图标，需要时可从状态栏菜单打开窗口。</p>
          </div>

          <div className="setting-field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.autoStartProxy}
                onChange={(event) => setDraft({ ...draft, autoStartProxy: event.target.checked })}
              />
              <span>启动后自动启动代理服务</span>
            </label>
            <p className="setting-hint">关闭后，应用启动时不会自动监听端口，可在主界面或状态栏菜单手动启动。</p>
          </div>

          <div className="setting-field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={!localOnly}
                onChange={(event) => setDraft({ ...draft, host: event.target.checked ? "0.0.0.0" : "127.0.0.1" })}
              />
              <span>允许局域网访问</span>
            </label>
            <p className={localOnly ? "setting-hint" : "setting-hint warning"}>
              {localOnly
                ? "关闭后只监听 127.0.0.1，只有本机可以访问。"
                : "开启后监听 0.0.0.0，局域网设备可通过这台机器的局域网 IP 和端口访问，请确认网络环境可信。"}
            </p>
          </div>

          <div className="setting-field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.hideDockOnClose}
                onChange={(event) => setDraft({ ...draft, hideDockOnClose: event.target.checked })}
              />
              <span>关闭窗口时隐藏 Dock 图标</span>
            </label>
            <p className="setting-hint">开启后，点击窗口关闭按钮会只保留菜单栏图标；关闭后，Dock 图标会继续显示。</p>
          </div>

          <div className="setting-field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.debug}
                onChange={(event) => setDraft({ ...draft, debug: event.target.checked })}
              />
              <span>调试日志</span>
            </label>
            <p className="setting-hint">开启后，代理保存和转发时会输出更多日志，便于排查问题。</p>
          </div>

          <label className="setting-field">
            <span>端口</span>
            <input className="settings-input" value={draft.port} inputMode="numeric" onChange={(event) => setDraft({ ...draft, port: event.target.value.trim() })} />
          </label>

          <div className="setting-field">
            <label>配置文件</label>
            <div className="config-path-row">
              <code>{configPath}</code>
              <button className="secondary-button" onClick={() => window.claudeAdapter.app.openConfigFolder()}>
                <FolderOpen size={15} />
                打开目录
              </button>
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="secondary-button" onClick={close} disabled={busy}>取消</button>
          <button className="primary-button" onClick={save} disabled={busy}>
            <Check size={15} />
            保存设置
          </button>
        </div>
      </section>
    </div>
  );
}

function ViewRow({
  model,
  visible,
  toggleVisibleKey,
  editRow,
  deleteRow,
  toggleEnabled,
  busy
}: {
  model: PublicModelConfig;
  visible: boolean;
  toggleVisibleKey(id: string): void;
  editRow(model: PublicModelConfig): void;
  deleteRow(id: string): void;
  toggleEnabled(id: string): void;
  busy: boolean;
}) {
  const enabled = model.enabled !== false;
  return (
    <tr className={enabled ? "" : "disabled-row"}>
      <td><strong>{model.localModelId}</strong></td>
      <td>{model.remoteModelId}</td>
      <td><ProtocolPill protocol={model.remoteProtocol} /></td>
      <td className="mono small">{model.remoteBaseUrl}</td>
      <td>
        <div className="key-field">
          <input readOnly value={visible ? model.remoteApiKey || "" : "••••••••"} />
          <button title={visible ? "隐藏密钥" : "显示密钥"} onClick={() => toggleVisibleKey(model.localModelId)}>
            {visible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </td>
      <td>
        <div className="row-actions">
          <button onClick={() => toggleEnabled(model.localModelId)} disabled={busy}>{enabled ? "禁用" : "启用"}</button>
          <button onClick={() => editRow(model)} disabled={busy}>编辑</button>
          <button onClick={() => deleteRow(model.localModelId)} disabled={busy} title="删除"><Trash2 size={15} /></button>
        </div>
      </td>
    </tr>
  );
}

function EditRow({
  draft,
  updateDraft,
  save,
  cancel,
  busy
}: {
  draft: DraftModel;
  updateDraft(field: keyof DraftModel, value: string | boolean): void;
  save(): void;
  cancel(): void;
  busy: boolean;
}) {
  return (
    <tr className="editing-row">
      <td><input value={draft.localModelId || ""} placeholder="例：claude-3-5-sonnet" onChange={(event) => updateDraft("localModelId", event.target.value)} /></td>
      <td><input value={draft.remoteModelId || ""} placeholder="例：provider-sonnet" onChange={(event) => updateDraft("remoteModelId", event.target.value)} /></td>
      <td>
        <select value={draft.remoteProtocol || "anthropic"} onChange={(event) => updateDraft("remoteProtocol", event.target.value as RemoteProtocol)}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI</option>
        </select>
      </td>
      <td><input value={draft.remoteBaseUrl || ""} placeholder="https://api.example.com/anthropic" onChange={(event) => updateDraft("remoteBaseUrl", event.target.value)} /></td>
      <td>
        <div className="key-field editable">
          <input
            type={draft.showApiKey ? "text" : "password"}
            value={draft.remoteApiKey || ""}
            placeholder="API Key"
            onChange={(event) => updateDraft("remoteApiKey", event.target.value)}
          />
          <button title={draft.showApiKey ? "隐藏密钥" : "显示密钥"} onClick={() => updateDraft("showApiKey", !draft.showApiKey)}>
            {draft.showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      </td>
      <td>
        <div className="row-actions">
          <button className="save-button" onClick={save} disabled={busy}><Check size={15} />保存</button>
          <button onClick={cancel} disabled={busy}><X size={15} />取消</button>
        </div>
      </td>
    </tr>
  );
}

function ProtocolPill({ protocol }: { protocol: RemoteProtocol }) {
  return <span className={protocol === "openai" ? "protocol openai" : "protocol"}>{protocol === "openai" ? "OpenAI" : "Anthropic"}</span>;
}

function toSettingsDraft(config: PublicConfig): SettingsDraft {
  return {
    host: config.host,
    port: String(config.port),
    hideDockOnClose: config.hideDockOnClose !== false,
    launchAtLogin: config.launchAtLogin === true,
    startHiddenToTray: config.startHiddenToTray === true,
    autoStartProxy: config.autoStartProxy !== false,
    debug: config.debug === true
  };
}

function normalizeDraft(draft: DraftModel): DraftModel {
  return {
    ...draft,
    localModelId: String(draft.localModelId || "").trim(),
    remoteModelId: String(draft.remoteModelId || "").trim(),
    remoteBaseUrl: String(draft.remoteBaseUrl || "").trim(),
    remoteApiKey: String(draft.remoteApiKey || "").trim(),
    remoteProtocol: draft.remoteProtocol === "openai" ? "openai" : "anthropic",
    enabled: draft.enabled !== false
  };
}

function validateDraft(draft: DraftModel, models: PublicModelConfig[]) {
  if (!draft.localModelId || !draft.remoteBaseUrl || !draft.remoteModelId) {
    return "请填写本地模型名、remoteBaseUrl 和 remoteModelId。";
  }
  if (!/^https?:\/\//i.test(draft.remoteBaseUrl)) {
    return "remoteBaseUrl 必须以 http:// 或 https:// 开头。";
  }
  const duplicate = models.some((model) => model.localModelId === draft.localModelId && model.localModelId !== draft.originalLocalModelId);
  return duplicate ? "这个本地模型名已经存在，请换一个。" : null;
}

function toModelInput(draft: DraftModel): WebModelInput {
  return {
    originalLocalModelId: draft.originalLocalModelId,
    localModelId: draft.localModelId,
    remoteModelId: draft.remoteModelId,
    remoteBaseUrl: draft.remoteBaseUrl,
    remoteApiKey: draft.remoteApiKey,
    remoteProtocol: draft.remoteProtocol,
    enabled: draft.enabled !== false
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatServiceError(message: string) {
  return message.includes("设置") ? message : `${message} 请打开设置修改监听端口。`;
}
