type PopupState = {
  connected: boolean;
  extensionId: string;
  nativeHostName: string;
  cliHint: string;
  lastError: string;
  recentToolExecutions?: RecentToolExecution[];
};

type RecentToolExecution = {
  id: string;
  name: string;
  at: string;
  ok: boolean;
  summary: string;
};

async function loadState(): Promise<PopupState> {
  const response = await chrome.runtime.sendMessage({ type: "chrome-relay.status" });
  return response as PopupState;
}

function setText(id: string, value: string): void {
  const element = document.getElementById(id);
  if (element) {
    element.textContent = value;
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function renderRecentTools(tools: RecentToolExecution[] = []): void {
  const list = document.getElementById("recent-tools");
  if (!list) {
    return;
  }

  list.textContent = "";

  if (tools.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No tool executions yet.";
    list.appendChild(empty);
    return;
  }

  for (const tool of tools.slice(0, 3)) {
    const item = document.createElement("li");
    item.className = tool.ok ? "tool ok" : "tool error";

    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;

    const meta = document.createElement("span");
    meta.className = "tool-meta";
    meta.textContent = `${tool.ok ? "ok" : "error"} · ${formatTime(tool.at)}`;

    const summary = document.createElement("span");
    summary.className = "tool-summary";
    summary.textContent = tool.summary;

    item.append(name, meta, summary);
    list.appendChild(item);
  }
}

function setupCopyButton(): void {
  const button = document.getElementById("copy-skill-command");
  const command = document.getElementById("skill-command")?.textContent?.trim();
  if (!button || !command) {
    return;
  }

  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(command);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1200);
  });
}

async function main(): Promise<void> {
  const state = await loadState();
  setText("extension-id", state.extensionId);
  setText("native-host", state.nativeHostName);
  setText("cli-hint", state.cliHint);
  setText("last-error", state.lastError || "None");
  renderRecentTools(state.recentToolExecutions);
  setupCopyButton();

  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  if (state.connected) {
    dot?.classList.add("connected");
    if (text) {
      text.textContent = "Native host connected";
    }
  } else if (text) {
    text.textContent = "Waiting for native host";
  }
}

void main();
