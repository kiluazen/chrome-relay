// chrome_upload — three upload strategies, no auto-fallback between them.
// Every strategy hands Chrome file PATHS (DOM.setFileInputFiles /
// Input.dispatchDragEvent both read the files browser-side); no bytes ever
// cross the bridge. See docs/multi-profile-and-upload.md Part 2.
//
//   set    — direct DOM.setFileInputFiles on an <input type="file">. Works
//            on HIDDEN inputs: resolution goes through DOM.describeNode,
//            never a box model (display:none inputs are the normal case).
//   choose — arm Page.setInterceptFileChooserDialog BEFORE clicking the
//            trigger (the arming order is what keeps the OS picker off the
//            user's screen), catch Page.fileChooserOpened, set files on the
//            intercepted node. Serialized per tab: two concurrent calls
//            would disarm each other in their finally blocks.
//   drop   — Input.dispatchDragEvent dragEnter → dragOver → drop with
//            path-based DragData.files at the target's center.

import {
  parseChromeUploadArgs,
  RelayError,
  TOOL_NAMES,
  type ChromeUploadArgs,
  type ToolName
} from "@chrome-relay/protocol";
import { send } from "../cdp";
import { resolveRefCenter, resolveRefTarget } from "../element";
import { getFileSchemeAccess } from "../identity";
import { inputHandlers } from "./input";
import { resolveTarget, requireTabId, type ToolHandler } from "./target";

const TOOL: ToolName = TOOL_NAMES.UPLOAD;
const DEFAULT_CHOOSER_TIMEOUT_MS = 5_000;

function fail(
  code: ConstructorParameters<typeof RelayError>[0]["code"],
  message: string,
  phase: string,
  details?: Record<string, unknown>,
  retryable = false
): never {
  throw new RelayError({ code, message: `${TOOL}: ${message}`, tool: TOOL, phase, details, retryable });
}

// ---------------------------------------------------------------------------
// File-access gate. Chrome gates debugger file operations behind the
// user-controlled "Allow access to file URLs" toggle; without it, uploads
// fail with an opaque CDP error on SOMEONE ELSE'S machine. Check up front
// and fail with remediation instead. undefined (API unavailable) proceeds —
// we only gate on a definite "off".
async function assertFileAccess(): Promise<void> {
  const allowed = await getFileSchemeAccess();
  if (allowed === false) {
    fail(
      "file_access_denied",
      'Chrome\'s "Allow access to file URLs" is OFF for this extension, which blocks debugger file operations. Fix: chrome://extensions → Chrome Relay → enable "Allow access to file URLs", then retry.',
      "preflight",
      { remediation: "chrome://extensions → Chrome Relay → Allow access to file URLs" }
    );
  }
}

// ---------------------------------------------------------------------------
// Node resolution + description helpers

function attributesToMap(flat: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!flat) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i].toLowerCase()] = flat[i + 1];
  return out;
}

interface DescribedNode {
  backendNodeId: number;
  nodeName: string;
  attrs: Record<string, string>;
}

async function describeBackendNode(tabId: number, backendNodeId: number): Promise<DescribedNode> {
  const desc = await send<{ node: { nodeName: string; attributes?: string[] } }>(
    tabId,
    "DOM.describeNode",
    { backendNodeId }
  );
  return { backendNodeId, nodeName: desc.node.nodeName, attrs: attributesToMap(desc.node.attributes) };
}

/** CSS selector → live backendNodeId. No box requirement — hidden nodes
 *  resolve fine (that's the point for file inputs). */
async function resolveSelectorNode(tabId: number, selector: string): Promise<DescribedNode> {
  const doc = await send<{ root: { nodeId: number } }>(tabId, "DOM.getDocument", { depth: 0 });
  const match = await send<{ nodeId: number }>(tabId, "DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector
  });
  if (!match.nodeId) {
    fail("element_not_found", `no element matches selector ${selector}`, "resolve_target", { selector });
  }
  const desc = await send<{ node: { nodeName: string; attributes?: string[]; backendNodeId: number } }>(
    tabId,
    "DOM.describeNode",
    { nodeId: match.nodeId }
  );
  return {
    backendNodeId: desc.node.backendNodeId,
    nodeName: desc.node.nodeName,
    attrs: attributesToMap(desc.node.attributes)
  };
}

/** Resolve the set/drop target (ref or selector) to a tab + described node.
 *  Ref path: resolveRefTarget enforces tab safety; liveness is verified by
 *  DOM.describeNode itself (it throws on a dead backendNodeId). */
async function resolveUploadTarget(parsed: ChromeUploadArgs): Promise<{ tabId: number; node: DescribedNode }> {
  if (parsed.ref !== undefined) {
    const entry = await resolveRefTarget(TOOL, parsed.ref, parsed);
    try {
      return { tabId: entry.tabId, node: await describeBackendNode(entry.tabId, entry.backendNodeId) };
    } catch (e) {
      if (e instanceof RelayError) throw e;
      fail(
        "stale_ref",
        `@${parsed.ref} no longer resolves. Re-run \`chrome-relay snapshot\` and use a fresh ref.`,
        "resolve_target",
        { ref: parsed.ref }
      );
    }
  }
  const tab = await resolveTarget(parsed);
  const tabId = requireTabId(tab);
  return { tabId, node: await resolveSelectorNode(tabId, parsed.selector as string) };
}

// ---------------------------------------------------------------------------
// Input validation + verified result

function assertIsFileInput(node: DescribedNode, how: string): void {
  const isFileInput = node.nodeName.toUpperCase() === "INPUT" && (node.attrs.type ?? "").toLowerCase() === "file";
  if (!isFileInput) {
    fail(
      "not_a_file_input",
      `${how} resolved to <${node.nodeName.toLowerCase()}${node.attrs.type ? ` type="${node.attrs.type}"` : ""}>, not <input type="file">. If the real input is hidden elsewhere, target it directly; if a button opens a picker, use action=choose.`,
      "validate_target",
      { nodeName: node.nodeName, type: node.attrs.type ?? null }
    );
  }
}

function assertMultipleAllowed(files: string[], allowsMultiple: boolean, source: string): void {
  if (files.length > 1 && !allowsMultiple) {
    fail(
      "multiple_not_supported",
      `${files.length} files passed but the target accepts a single file (${source}). Site behavior for the overflow would be undefined — pass one file.`,
      "validate_target",
      { fileCount: files.length, source }
    );
  }
}

/** accept-attr check. A NOTICE-grade signal (sites lie about accept), so it
 *  rides in the result data as `warnings`, never fails the call. Only plain
 *  `.ext` tokens are compared — mime patterns can't be judged from a path. */
function acceptWarnings(files: string[], accept: string | undefined): Array<Record<string, unknown>> {
  if (!accept) return [];
  const tokens = accept.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  const extTokens = tokens.filter((t) => t.startsWith("."));
  if (extTokens.length === 0 || extTokens.length !== tokens.length) return []; // mime patterns present — can't judge
  const warnings: Array<Record<string, unknown>> = [];
  for (const path of files) {
    const dot = path.lastIndexOf(".");
    const ext = dot >= 0 ? path.slice(dot).toLowerCase() : "";
    if (!extTokens.includes(ext)) {
      warnings.push({ code: "accept_mismatch", file: path, accept });
    }
  }
  return warnings;
}

/** Read back what the input ACTUALLY holds after setFileInputFiles —
 *  verified results, not assumed. */
async function readBackFiles(tabId: number, backendNodeId: number): Promise<Array<{ name: string; size: number; type: string }>> {
  const resolved = await send<{ object: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
  if (!resolved.object?.objectId) return [];
  const read = await send<{ result: { value?: Array<{ name: string; size: number; type: string }> } }>(
    tabId,
    "Runtime.callFunctionOn",
    {
      objectId: resolved.object.objectId,
      functionDeclaration:
        "function () { return Array.from(this.files ?? []).map((f) => ({ name: f.name, size: f.size, type: f.type })); }",
      returnByValue: true
    }
  );
  return read.result?.value ?? [];
}

async function setFilesOnNode(
  tabId: number,
  node: DescribedNode,
  files: string[]
): Promise<Record<string, unknown>> {
  await send(tabId, "DOM.setFileInputFiles", { files, backendNodeId: node.backendNodeId });
  const held = await readBackFiles(tabId, node.backendNodeId);
  const warnings = acceptWarnings(files, node.attrs.accept);
  return {
    files: held,
    input: {
      multiple: "multiple" in node.attrs,
      ...(node.attrs.accept ? { accept: node.attrs.accept } : {})
    },
    ...(warnings.length > 0 ? { warnings } : {})
  };
}

// ---------------------------------------------------------------------------
// action=set

async function uploadSet(parsed: ChromeUploadArgs): Promise<unknown> {
  const { tabId, node } = await resolveUploadTarget(parsed);
  assertIsFileInput(node, parsed.ref !== undefined ? `@${parsed.ref}` : `selector ${parsed.selector}`);
  assertMultipleAllowed(parsed.files, "multiple" in node.attrs, "input has no `multiple` attribute");
  return { tabId, ...(await setFilesOnNode(tabId, node, parsed.files)) };
}

// ---------------------------------------------------------------------------
// action=choose
//
// Interception is serialized per tab: `armedTabs` guards entry, released in
// the finally that also disarms. Tab close/navigation while armed rejects
// the wait with target_closed.

const armedTabs = new Set<number>();

if (typeof chrome !== "undefined" && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => armedTabs.delete(tabId));
}

interface FileChooserEvent {
  frameId?: string;
  mode?: string;
  backendNodeId?: number;
}

function waitForChooser(tabId: number, timeoutMs: number): Promise<FileChooserEvent> {
  return new Promise<FileChooserEvent>((resolve, reject) => {
    const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
      if (source.tabId !== tabId || method !== "Page.fileChooserOpened") return;
      // A sessionId marks a CHILD debugger session (out-of-process iframe).
      // Our setFileInputFiles would run on the ROOT session and miss or hit
      // the wrong document — reject explicitly instead of acting blind.
      if ((source as { sessionId?: string }).sessionId) {
        cleanup();
        reject(
          new RelayError({
            code: "file_chooser_unsupported",
            message: `${TOOL}: the file chooser opened inside an out-of-process iframe — v1 drives top-frame choosers only. Try action=set on the frame's input via a selector.`,
            tool: TOOL,
            phase: "await_chooser",
            details: { tabId, childSession: true },
            retryable: false
          })
        );
        return;
      }
      cleanup();
      resolve((params ?? {}) as FileChooserEvent);
    };
    const onRemoved = (closedTabId: number) => {
      if (closedTabId !== tabId) return;
      cleanup();
      reject(
        new RelayError({
          code: "target_closed",
          message: `${TOOL}: tab ${tabId} closed while the file-chooser interception was armed.`,
          tool: TOOL,
          phase: "await_chooser",
          details: { tabId },
          retryable: false
        })
      );
    };
    const onUpdated = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId !== tabId || changeInfo.status !== "loading") return;
      cleanup();
      reject(
        new RelayError({
          code: "target_closed",
          message: `${TOOL}: tab ${tabId} navigated while the file-chooser interception was armed.`,
          tool: TOOL,
          phase: "await_chooser",
          details: { tabId },
          retryable: false
        })
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new RelayError({
          code: "no_file_chooser",
          message: `${TOOL}: the click did not open a file dialog within ${timeoutMs}ms — wrong trigger, or the site uses a drop zone. Try action=set on a hidden <input type="file">, or action=drop on the drop zone.`,
          tool: TOOL,
          phase: "await_chooser",
          details: { tabId, timeoutMs },
          retryable: false
        })
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(onEvent);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
    chrome.debugger.onEvent.addListener(onEvent);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function uploadChoose(parsed: ChromeUploadArgs): Promise<unknown> {
  // Resolve the trigger's tab BEFORE arming — a clickRef carries its own
  // tab; a clickSelector goes through normal target resolution.
  let tabId: number;
  if (parsed.clickRef !== undefined) {
    const entry = await resolveRefTarget(TOOL, parsed.clickRef, parsed);
    tabId = entry.tabId;
  } else {
    tabId = requireTabId(await resolveTarget(parsed));
  }

  if (armedTabs.has(tabId)) {
    fail(
      "file_chooser_busy",
      `another upload choose is already armed on tab ${tabId}. Interception is serialized per tab — retry after it settles.`,
      "arm_interception",
      { tabId },
      true
    );
  }
  armedTabs.add(tabId);

  try {
    // Arm FIRST — this is what suppresses the OS picker the click would
    // otherwise pop on the user's screen.
    await send(tabId, "Page.enable", {});
    await send(tabId, "Page.setInterceptFileChooserDialog", { enabled: true });

    const chooserPromise = waitForChooser(tabId, parsed.timeoutMs ?? DEFAULT_CHOOSER_TIMEOUT_MS);
    // Swallow late rejections (e.g. timeout firing after the click already
    // threw) — the click error is the verdict on that path.
    chooserPromise.catch(() => {});

    // Click the trigger through the NORMAL click path — same hit-testing,
    // same failure codes. Direct handler call (not runTool) avoids an
    // import cycle through tools.ts.
    const clickHandler = inputHandlers[TOOL_NAMES.CLICK];
    if (!clickHandler) {
      fail("internal_error", "click handler unavailable", "click_trigger");
    }
    const clickArgs: Record<string, unknown> =
      parsed.clickRef !== undefined
        ? { ref: parsed.clickRef }
        : {
            selector: parsed.clickSelector,
            ...(parsed.tabId !== undefined ? { tabId: parsed.tabId } : {}),
            ...(parsed.workspaceName ? { workspaceName: parsed.workspaceName } : {}),
            ...(parsed.groupName ? { groupName: parsed.groupName } : {})
          };
    await clickHandler(clickArgs);

    const chooser = await chooserPromise;

    if (chooser.backendNodeId === undefined) {
      fail(
        "file_chooser_unsupported",
        "a file chooser opened but carries no target node (non-input-backed chooser, or an out-of-process iframe) — this strategy can't drive it. Try action=set on the underlying input if one exists.",
        "set_files",
        { mode: chooser.mode ?? null }
      );
    }
    assertMultipleAllowed(parsed.files, chooser.mode === "selectMultiple", `chooser mode is ${chooser.mode ?? "selectSingle"}`);

    const node = await describeBackendNode(tabId, chooser.backendNodeId);
    return { tabId, mode: chooser.mode ?? "selectSingle", ...(await setFilesOnNode(tabId, node, parsed.files)) };
  } finally {
    armedTabs.delete(tabId);
    try {
      await send(tabId, "Page.setInterceptFileChooserDialog", { enabled: false });
    } catch {
      /* tab gone or debugger detached — nothing left to disarm */
    }
  }
}

// ---------------------------------------------------------------------------
// action=drop

async function uploadDrop(parsed: ChromeUploadArgs): Promise<unknown> {
  let tabId: number;
  let x: number;
  let y: number;
  let backendNodeId: number;

  if (parsed.ref !== undefined) {
    const resolved = await resolveRefCenter(TOOL, parsed.ref, parsed, { hitTest: false });
    ({ tabId, x, y, backendNodeId } = resolved);
  } else {
    tabId = requireTabId(await resolveTarget(parsed));
    const node = await resolveSelectorNode(tabId, parsed.selector as string);
    backendNodeId = node.backendNodeId;
    try {
      await send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    } catch {
      /* optional */
    }
    const box = await send<{ model: { content: number[] } }>(tabId, "DOM.getBoxModel", { backendNodeId });
    const q = box.model.content;
    x = Math.round((q[0] + q[2] + q[4] + q[6]) / 4);
    y = Math.round((q[1] + q[3] + q[5] + q[7]) / 4);
  }

  // Best-effort observability probe: a one-shot window-level drop listener
  // that records whether any handler called preventDefault (the observable
  // signal that a drop zone processed the drop). Never blocks the drop.
  let probeArmed = false;
  try {
    await send(tabId, "Runtime.evaluate", {
      expression:
        "window.__chromeRelayDropHandled = undefined;" +
        "window.addEventListener('drop', (e) => { window.__chromeRelayDropHandled = e.defaultPrevented; }, { once: true, capture: false });",
      returnByValue: true
    });
    probeArmed = true;
  } catch {
    /* probe is optional */
  }

  const data = { items: [], files: parsed.files, dragOperationsMask: 1 };
  for (const type of ["dragEnter", "dragOver", "drop"] as const) {
    await send(tabId, "Input.dispatchDragEvent", { type, x, y, data });
  }

  let dropHandled: boolean | null = null;
  if (probeArmed) {
    try {
      const read = await send<{ result: { value?: boolean } }>(tabId, "Runtime.evaluate", {
        expression: "window.__chromeRelayDropHandled",
        returnByValue: true
      });
      dropHandled = typeof read.result?.value === "boolean" ? read.result.value : null;
    } catch {
      /* stays null — unobservable */
    }
  }

  // dropHandled is what's OBSERVABLE. Whether the app accepted the files is
  // app state — the agent verifies via snapshot, same as after any click.
  return { tabId, x, y, dispatched: true, dropHandled };
}

// ---------------------------------------------------------------------------

export const uploadHandlers: Partial<Record<string, ToolHandler>> = {
  async [TOOL_NAMES.UPLOAD](args) {
    const parsed = parseChromeUploadArgs(args);
    await assertFileAccess();
    switch (parsed.action) {
      case "set":
        return uploadSet(parsed);
      case "choose":
        return uploadChoose(parsed);
      case "drop":
        return uploadDrop(parsed);
    }
  }
};
