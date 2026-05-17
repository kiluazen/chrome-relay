import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { buildProgram } from "../src/program";

type FetchSpy = ReturnType<typeof vi.fn>;

let fetchSpy: FetchSpy;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;

function mockBridgeResponse(body: unknown, ok = true, status = 200) {
  fetchSpy.mockResolvedValueOnce({
    ok,
    status,
    json: async () => body
  } as Response);
}

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  // Default: every call returns ok with empty data so commands don't blow up.
  fetchSpy.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data: {} })
  }));
  exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function runArgs(...args: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(["node", "chrome-relay", ...args]);
}

function lastBody(): { name: string; args: Record<string, unknown> } {
  const calls = fetchSpy.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const body = calls.at(-1)?.[1]?.body;
  expect(typeof body).toBe("string");
  return JSON.parse(body as string);
}

describe("CLI argument parsing", () => {
  describe("tabs", () => {
    it("posts get_windows_and_tabs with no args", async () => {
      await runArgs("tabs");
      expect(lastBody()).toEqual({ name: "get_windows_and_tabs", args: {} });
    });
  });

  describe("navigate", () => {
    it("posts chrome_navigate with url", async () => {
      await runArgs("navigate", "https://example.com");
      expect(lastBody()).toEqual({
        name: "chrome_navigate",
        args: { url: "https://example.com" }
      });
    });

    it("includes tabId when --tab is passed", async () => {
      await runArgs("navigate", "--tab", "777", "https://example.com");
      expect(lastBody().args).toMatchObject({ url: "https://example.com", tabId: 777 });
    });

    it("sets newTab=true with --new", async () => {
      await runArgs("navigate", "https://example.com", "--new");
      expect(lastBody().args).toMatchObject({ newTab: true });
    });

    it("sets active=false with --inactive", async () => {
      await runArgs("navigate", "https://example.com", "--inactive");
      expect(lastBody().args).toMatchObject({ active: false });
    });

    it("rejects bare numeric URL with helpful stderr message", async () => {
      await runArgs("navigate", "12345");
      const stderrCalls = (stderrSpy.mock.calls as string[][]).map((c) => c[0]).join("\n");
      expect(stderrCalls).toMatch(/looks like a tab ID/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("screenshot", () => {
    it("posts chrome_screenshot with no args by default", async () => {
      await runArgs("screenshot");
      expect(lastBody()).toEqual({ name: "chrome_screenshot", args: {} });
    });

    it("forwards --tab and --full", async () => {
      await runArgs("screenshot", "--tab", "42", "--full");
      expect(lastBody().args).toEqual({ tabId: 42, fullPage: true });
    });

    it("forwards --bbox unchanged (parsing happens in the extension)", async () => {
      await runArgs("screenshot", "--tab", "42", "--bbox", "0,0,1280,80");
      expect(lastBody().args).toEqual({ tabId: 42, bbox: "0,0,1280,80" });
    });

    it("forwards --selector + --padding", async () => {
      await runArgs("screenshot", "--tab", "42", "--selector", ".card", "--padding", "8");
      expect(lastBody().args).toEqual({ tabId: 42, selector: ".card", padding: 8 });
    });
  });

  describe("network (§2.7a)", () => {
    it("default (read) posts chrome_network with just tabId", async () => {
      await runArgs("network", "--tab", "42");
      expect(lastBody()).toEqual({ name: "chrome_network", args: { tabId: 42 } });
    });
    it("filter + status + method + limit are forwarded (Issue #6: parent-level flags)", async () => {
      // These flags now live on the parent `network` command, so `chrome-relay network --filter X`
      // works without spelling out `read`.
      await runArgs("network", "--tab", "42", "--filter", "api.", "--status", "ok", "--method", "POST", "--limit", "10");
      expect(lastBody().args).toEqual({
        tabId: 42, filter: "api.", status: "ok", method: "POST", limit: 10
      });
    });
    it("network read alias still works with the same flags", async () => {
      await runArgs("network", "read", "--tab", "42", "--filter", "api.");
      expect(lastBody().args).toEqual({ tabId: 42, filter: "api." });
    });
    it("body subcommand sets action=body + requestId (default 8KB truncation server-side)", async () => {
      await runArgs("network", "body", "req-123", "--tab", "42");
      expect(lastBody()).toEqual({
        name: "chrome_network",
        args: { tabId: 42, action: "body", requestId: "req-123" }
      });
    });
    it("body --full opts out of the 8KB head truncation (Issue #5)", async () => {
      await runArgs("network", "body", "req-1", "--tab", "42", "--full");
      expect(lastBody().args).toEqual({ tabId: 42, action: "body", requestId: "req-1", full: true });
    });
    it("body --head <bytes> caps explicitly (Issue #5)", async () => {
      await runArgs("network", "body", "req-1", "--tab", "42", "--head", "1024");
      expect(lastBody().args).toEqual({ tabId: 42, action: "body", requestId: "req-1", head: 1024 });
    });
    it("har subcommand sets action=har", async () => {
      await runArgs("network", "har", "--tab", "42");
      expect(lastBody().args).toMatchObject({ tabId: 42, action: "har" });
    });
    it("har --with-bodies opts into the eager-fetch path (Issue #3)", async () => {
      await runArgs("network", "har", "--tab", "42", "--with-bodies");
      expect(lastBody().args).toMatchObject({ tabId: 42, action: "har", withBodies: true });
    });
    it("har prints the bodyless warning to stderr when --with-bodies is omitted (Issue #3)", async () => {
      await runArgs("network", "har", "--tab", "42");
      const stderrText = stderrSpy.mock.calls.map((c) => c[0]).join("");
      expect(stderrText).toMatch(/HAR exported WITHOUT response bodies/);
    });
    it("clear subcommand sets action=clear", async () => {
      await runArgs("network", "clear", "--tab", "42");
      expect(lastBody().args).toMatchObject({ tabId: 42, action: "clear" });
    });
  });

  describe("screenshot --max-edge (Issue #2)", () => {
    it("forwards --max-edge as maxEdge", async () => {
      await runArgs("screenshot", "--tab", "42", "--max-edge", "1600");
      expect(lastBody().args).toEqual({ tabId: 42, maxEdge: 1600 });
    });
  });

  describe("tabs list alias (Issue #7)", () => {
    it("bare `tabs` still works", async () => {
      await runArgs("tabs");
      expect(lastBody()).toEqual({ name: "get_windows_and_tabs", args: {} });
    });
    it("`tabs list` is accepted as an alias", async () => {
      await runArgs("tabs", "list");
      expect(lastBody()).toEqual({ name: "get_windows_and_tabs", args: {} });
    });
  });

  describe("ax (§2.4)", () => {
    it("ax default posts chrome_ax with just tabId", async () => {
      await runArgs("ax", "--tab", "42");
      expect(lastBody()).toEqual({ name: "chrome_ax", args: { tabId: 42 } });
    });
    it("ax --interactive-only --root main --include-subframes forwards every flag", async () => {
      await runArgs("ax", "--tab", "42", "--interactive-only", "--root", "main", "--include-subframes");
      expect(lastBody().args).toEqual({
        tabId: 42,
        interactiveOnly: true,
        rootRole: "main",
        includeSubframes: true
      });
    });
    it("click-ax requires --node and forwards it", async () => {
      await runArgs("click-ax", "--tab", "42", "--node", "123");
      expect(lastBody()).toEqual({ name: "chrome_click_ax", args: { tabId: 42, node: 123 } });
    });
  });

  // 0.4.0 split: what was a "group" (= named Chrome window) is now a
  // "workspace." The `group` subcommand now wraps Chrome's native tab-group
  // primitive (the colored folder inside one window).
  describe("workspace (named Chrome windows)", () => {
    it("create posts action=create + name (+ url + label)", async () => {
      await runArgs("workspace", "create", "bidsmith-h01", "--url", "https://reddit.com", "--label", "ad ops");
      expect(lastBody()).toEqual({
        name: "chrome_workspace",
        args: { action: "create", name: "bidsmith-h01", url: "https://reddit.com", label: "ad ops" }
      });
    });

    it("list posts action=list with no extras", async () => {
      await runArgs("workspace", "list");
      expect(lastBody()).toEqual({ name: "chrome_workspace", args: { action: "list" } });
    });

    it("close posts action=close + name", async () => {
      await runArgs("workspace", "close", "bidsmith-h01");
      expect(lastBody()).toEqual({
        name: "chrome_workspace",
        args: { action: "close", name: "bidsmith-h01" }
      });
    });

    it("--workspace on a normal subcommand sets workspaceName", async () => {
      await runArgs("navigate", "https://example.com", "--workspace", "bidsmith-h01");
      expect(lastBody().args).toMatchObject({ url: "https://example.com", workspaceName: "bidsmith-h01" });
    });

    it("rejects --tab + --workspace on the same subcommand (PR 2 strict)", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await runArgs("read", "--tab", "42", "--workspace", "any");
      const stderrText = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(stderrText).toMatch(/target_conflict.*subcommand.*--tab.*--workspace/);
      expect(exitSpy).toHaveBeenCalledWith(2);
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  describe("group (Chrome tab-groups — colored folders inside one window)", () => {
    it("create posts action=create + name + parsed tabIds (+ color)", async () => {
      await runArgs("group", "create", "research", "--tabs", "123,456,789", "--color", "cyan");
      expect(lastBody()).toEqual({
        name: "chrome_group",
        args: { action: "create", name: "research", tabIds: [123, 456, 789], color: "cyan" }
      });
    });

    it("create with --collapsed forwards the flag", async () => {
      await runArgs("group", "create", "later", "--tabs", "1", "--collapsed");
      expect(lastBody()).toEqual({
        name: "chrome_group",
        args: { action: "create", name: "later", tabIds: [1], collapsed: true }
      });
    });

    it("list posts action=list", async () => {
      await runArgs("group", "list");
      expect(lastBody()).toEqual({ name: "chrome_group", args: { action: "list" } });
    });

    it("close posts action=close + name", async () => {
      await runArgs("group", "close", "research");
      expect(lastBody()).toEqual({ name: "chrome_group", args: { action: "close", name: "research" } });
    });

    it("add posts action=add + name + tabIds", async () => {
      await runArgs("group", "add", "research", "--tabs", "1011");
      expect(lastBody()).toEqual({
        name: "chrome_group",
        args: { action: "add", name: "research", tabIds: [1011] }
      });
    });

    it("remove posts action=remove + tabIds (no name)", async () => {
      await runArgs("group", "remove", "--tabs", "456,789");
      expect(lastBody()).toEqual({
        name: "chrome_group",
        args: { action: "remove", tabIds: [456, 789] }
      });
    });

    it("--group on a normal subcommand sets groupName", async () => {
      await runArgs("navigate", "https://example.com", "--group", "research");
      expect(lastBody().args).toMatchObject({ url: "https://example.com", groupName: "research" });
    });

    it("--workspace + --group on the same command forward both", async () => {
      await runArgs("read", "--workspace", "ws", "--group", "g");
      expect(lastBody().args).toMatchObject({ workspaceName: "ws", groupName: "g" });
    });
  });

  describe("viewport (§2.2)", () => {
    it("preset posts action=preset + name", async () => {
      await runArgs("viewport", "preset", "iphone-14", "--tab", "42");
      expect(lastBody()).toEqual({
        name: "chrome_viewport",
        args: { action: "preset", name: "iphone-14", tabId: 42 }
      });
    });

    it("set requires width and height; forwards dpr + mobile + touch + ua", async () => {
      await runArgs(
        "viewport", "set",
        "--tab", "42",
        "--width", "390", "--height", "844",
        "--dpr", "3",
        "--mobile",
        "--touch",
        "--user-agent", "Mozilla/5.0 (iPhone)..."
      );
      expect(lastBody().args).toEqual({
        action: "set",
        tabId: 42,
        width: 390,
        height: 844,
        dpr: 3,
        mobile: true,
        hasTouch: true,
        userAgent: "Mozilla/5.0 (iPhone)..."
      });
    });

    it("clear posts action=clear", async () => {
      await runArgs("viewport", "clear", "--tab", "42");
      expect(lastBody()).toEqual({
        name: "chrome_viewport",
        args: { action: "clear", tabId: 42 }
      });
    });

    it("list posts action=list with no tab", async () => {
      await runArgs("viewport", "list");
      expect(lastBody()).toEqual({
        name: "chrome_viewport",
        args: { action: "list" }
      });
    });
  });

  describe("read", () => {
    it("posts chrome_read_page with no flags", async () => {
      await runArgs("read");
      expect(lastBody()).toEqual({ name: "chrome_read_page", args: {} });
    });

    it("sets interactiveOnly with -i", async () => {
      await runArgs("read", "--tab", "5", "-i");
      expect(lastBody().args).toEqual({ tabId: 5, interactiveOnly: true });
    });
  });

  describe("click", () => {
    it("posts chrome_click_element with selector", async () => {
      await runArgs("click", "button.submit");
      expect(lastBody()).toEqual({
        name: "chrome_click_element",
        args: { selector: "button.submit" }
      });
    });

    it("forwards --tab", async () => {
      await runArgs("click", "--tab", "9", "#go");
      expect(lastBody().args).toEqual({ selector: "#go", tabId: 9 });
    });
  });

  describe("fill", () => {
    it("posts chrome_fill_or_select with selector and value", async () => {
      await runArgs("fill", "input[name=q]", "hello");
      expect(lastBody()).toEqual({
        name: "chrome_fill_or_select",
        args: { selector: "input[name=q]", value: "hello" }
      });
    });

    it("forwards --tab", async () => {
      await runArgs("fill", "--tab", "10", "select#country", "IN");
      expect(lastBody().args).toEqual({
        selector: "select#country",
        value: "IN",
        tabId: 10
      });
    });
  });

  describe("keys", () => {
    it("passes the chord through verbatim", async () => {
      await runArgs("keys", "Cmd+K");
      expect(lastBody()).toEqual({
        name: "chrome_keyboard",
        args: { keys: "Cmd+K" }
      });
    });

    it("forwards --tab", async () => {
      await runArgs("keys", "--tab", "3", "Enter");
      expect(lastBody().args).toEqual({ keys: "Enter", tabId: 3 });
    });
  });

  describe("type", () => {
    it("posts chrome_type with text", async () => {
      await runArgs("type", "hello world");
      expect(lastBody()).toEqual({
        name: "chrome_type",
        args: { text: "hello world" }
      });
    });

    it("forwards --selector", async () => {
      await runArgs("type", "-s", "[data-testid=tweet]", "tweet body");
      expect(lastBody().args).toEqual({
        text: "tweet body",
        selector: "[data-testid=tweet]"
      });
    });

    it("forwards --selector and --tab together", async () => {
      await runArgs("type", "--tab", "12", "-s", "#draft", "x");
      expect(lastBody().args).toEqual({
        text: "x",
        selector: "#draft",
        tabId: 12
      });
    });
  });

  describe("js", () => {
    it("posts chrome_evaluate with code", async () => {
      await runArgs("js", "return document.title");
      expect(lastBody()).toEqual({
        name: "chrome_evaluate",
        args: { code: "return document.title" }
      });
    });

    it("forwards --timeout-ms as numeric timeoutMs", async () => {
      await runArgs("js", "--timeout-ms", "5000", "return 1");
      expect(lastBody().args).toEqual({
        code: "return 1",
        timeoutMs: 5000
      });
    });

    it("forwards --tab", async () => {
      await runArgs("js", "--tab", "44", "return 1");
      expect(lastBody().args).toEqual({
        code: "return 1",
        tabId: 44
      });
    });
  });

  describe("switch", () => {
    it("posts chrome_switch_tab with numeric tabId", async () => {
      await runArgs("switch", "987654");
      expect(lastBody()).toEqual({
        name: "chrome_switch_tab",
        args: { tabId: 987654 }
      });
    });
  });

  describe("close", () => {
    it("posts chrome_close_tabs with array of numbers", async () => {
      await runArgs("close", "1", "2", "3");
      expect(lastBody()).toEqual({
        name: "chrome_close_tabs",
        args: { tabIds: [1, 2, 3] }
      });
    });
  });

  describe("call (raw)", () => {
    it("posts the named tool with raw JSON args", async () => {
      await runArgs("call", "chrome_screenshot", '{"tabId":7,"fullPage":true}');
      expect(lastBody()).toEqual({
        name: "chrome_screenshot",
        args: { tabId: 7, fullPage: true }
      });
    });

    it("posts with empty args when JSON missing", async () => {
      await runArgs("call", "get_windows_and_tabs");
      expect(lastBody()).toEqual({
        name: "get_windows_and_tabs",
        args: {}
      });
    });
  });

  describe("error surfacing", () => {
    it("writes bridge errors to stderr and exits 1", async () => {
      mockBridgeResponse({ ok: false, error: "Native host unreachable" }, false, 503);
      await runArgs("tabs");
      const stderr = (stderrSpy.mock.calls as string[][]).map((c) => c[0]).join("");
      expect(stderr).toMatch(/Native host unreachable/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("surfaces tool-level error on 200 response with ok=false", async () => {
      mockBridgeResponse({ ok: false, error: "Element not found" });
      await runArgs("click", "#missing");
      const stderr = (stderrSpy.mock.calls as string[][]).map((c) => c[0]).join("");
      expect(stderr).toMatch(/Element not found/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("output formatting", () => {
    it("pretty-prints JSON object responses", async () => {
      mockBridgeResponse({ ok: true, data: { foo: "bar", n: 1 } });
      await runArgs("tabs");
      const stdout = (stdoutSpy.mock.calls as string[][]).map((c) => c[0]).join("");
      expect(stdout).toContain('"foo": "bar"');
      expect(stdout).toContain('"n": 1');
    });

    it("writes string responses without JSON-stringifying", async () => {
      mockBridgeResponse({ ok: true, data: "hello" });
      await runArgs("call", "anything");
      const stdout = (stdoutSpy.mock.calls as string[][]).map((c) => c[0]).join("");
      expect(stdout).toContain("hello");
      expect(stdout).not.toContain('"hello"');
    });
  });
});

describe("HTTP transport", () => {
  it("POSTs JSON to 127.0.0.1:12122/call", async () => {
    await runArgs("tabs");
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:12122/call");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
  });
});
