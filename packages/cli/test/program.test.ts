import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { buildProgram } from "../src/program";

// The CLI's hot path uses a fetch-shaped node:http client (client/http.ts);
// route it to the stubbed global fetch so these tests keep one seam.
vi.mock("../src/client/http.js", () => ({
  httpRequest: (url: string, init?: unknown) => (globalThis.fetch as (u: string, i?: unknown) => unknown)(url, init)
}));

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
  // Hermetic routing: an empty registry home means resolveRoute always takes
  // the legacy fixed-port fallback, so these argv→body tests never depend on
  // (or touch) the developer machine's real ~/.chrome-relay.
  process.env.CHROME_RELAY_HOME = "/nonexistent/chrome-relay-test-home";
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
  delete process.env.CHROME_RELAY_HOME;
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
    it("posts chrome_navigate with url, waiting for DOMContentLoaded by default", async () => {
      await runArgs("navigate", "https://example.com");
      expect(lastBody()).toEqual({
        name: "chrome_navigate",
        args: { url: "https://example.com", waitUntil: "domcontentloaded" }
      });
    });

    it("--wait and --timeout pass through; --wait none opts out", async () => {
      await runArgs("navigate", "https://example.com", "--new", "--wait", "load", "--timeout", "5000");
      expect(lastBody().args).toMatchObject({ newTab: true, waitUntil: "load", waitTimeoutMs: 5000 });
      await runArgs("navigate", "https://example.com", "--wait", "none");
      expect(lastBody().args).toMatchObject({ waitUntil: "none" });
    });

    it("--snapshot follows the action with an interactive snapshot of the tab it opened", async () => {
      mockBridgeResponse({ ok: true, data: { tabId: 55, url: "https://example.com", ready: true } });
      mockBridgeResponse({ ok: true, data: { title: "Ex", url: "https://example.com", tabId: 55, nodeCount: 1, nodes: [{ role: "link", name: "More", ref: "e1" }], refs: {} } });
      await runArgs("navigate", "https://example.com", "--new", "--snapshot");
      const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(String((c[1] as { body: string }).body)));
      expect(bodies.map((b) => b.name)).toEqual(["chrome_navigate", "chrome_snapshot"]);
      expect(bodies[1].args).toEqual({ tabId: 55, interactiveOnly: true });
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain('"tabId": 55');
      expect(out).toContain('link "More" [ref=e1]');
    });

    it("rejects an unknown --wait state before calling the bridge", async () => {
      await runArgs("navigate", "https://example.com", "--wait", "idle");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("includes tabId when --tab is passed", async () => {
      await runArgs("navigate", "--tab", "777", "https://example.com");
      expect(lastBody().args).toMatchObject({ url: "https://example.com", tabId: 777 });
    });

    it("sets newTab=true with --new", async () => {
      await runArgs("navigate", "https://example.com", "--new");
      expect(lastBody().args).toMatchObject({ newTab: true });
    });

    it("does NOT set active by default — chrome-relay never steals focus on its own", async () => {
      await runArgs("navigate", "https://example.com");
      expect(lastBody().args).not.toHaveProperty("active");
    });

    it("rejects --active locally before contacting any browser", async () => {
      await runArgs("navigate", "https://example.com", "--active");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy.mock.calls.map((c) => c[0]).join("\n")).toContain("background_only");
    });

    it("rejects foreground requests in raw calls and batches even with an older extension", async () => {
      for (const command of [
        { name: "chrome_navigate", args: { url: "https://example.com", active: true } },
        { name: "chrome_switch_tab", args: { tabId: 42 } }
      ]) {
        await runArgs("call", command.name, JSON.stringify(command.args));
        await runArgs("batch", JSON.stringify([command]), "--no-bail");
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
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
    it("validates known tool args locally before posting to the bridge", async () => {
      await runArgs("network", "body", "req-1", "--tab", "42", "--head", "-1");
      expect(fetchSpy).not.toHaveBeenCalled();
      const stderrText = stderrSpy.mock.calls.map((c) => c[0]).join("");
      expect(stderrText).toMatch(/chrome_network/);
      expect(stderrText).toMatch(/relayError/);
      expect(exitSpy).toHaveBeenCalledWith(1);
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
    it("ax is a snapshot alias: --root/--include-subframes are accepted but not forwarded", async () => {
      await runArgs("ax", "--tab", "42", "--interactive-only", "--root", "main", "--include-subframes");
      expect(lastBody().args).toEqual({
        tabId: 42,
        interactiveOnly: true
      });
    });
    it("click-ax requires --node and forwards it", async () => {
      await runArgs("click-ax", "--tab", "42", "--node", "123");
      expect(lastBody()).toEqual({ name: "chrome_click_ax", args: { tabId: 42, node: 123 } });
    });
  });

  describe("snapshot (adoption-spec Change 1)", () => {
    it("posts chrome_snapshot with flags and renders the compact text", async () => {
      mockBridgeResponse({
        ok: true,
        data: {
          title: "T", url: "https://x.test/", tabId: 42, nodeCount: 1,
          nodes: [{ role: "button", name: "Save", ref: "e1" }],
          refs: { e1: { tabId: 42, backendNodeId: 5, role: "button", name: "Save" } }
        }
      });
      await runArgs("snapshot", "--tab", "42", "-i", "-d", "3", "-s", "#main", "-u");
      expect(lastBody()).toEqual({
        name: "chrome_snapshot",
        args: { tabId: 42, interactiveOnly: true, depth: 3, scope: "#main", urls: true }
      });
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain('- button "Save" [ref=e1]');
      expect(out).not.toContain("backendNodeId"); // refs map stays off stdout in text mode
    });

    it("click @ref --snapshot settles, then snapshots the ref's own tab", async () => {
      mockBridgeResponse({ ok: true, data: { clicked: true, x: 1, y: 2, ref: "e3", tabId: 77 } });
      mockBridgeResponse({ ok: true, data: { title: "", url: "", tabId: 77, nodeCount: 0, nodes: [], refs: {} } });
      await runArgs("click", "@e3", "--snapshot");
      const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(String((c[1] as { body: string }).body)));
      // Armed with the click; the grace period is settle's job now.
      expect(bodies[0].args).toEqual({ ref: "e3", waitForNavigation: false, settle: true });
      expect(bodies[1]).toEqual({ name: "chrome_snapshot", args: { tabId: 77, interactiveOnly: true, settle: true } });
    });

    it("keys --snapshot reuses the action's target when the result names no tab", async () => {
      mockBridgeResponse({ ok: true, data: { sent: true, keys: "Enter" } });
      mockBridgeResponse({ ok: true, data: { title: "", url: "", tabId: 9, nodeCount: 0, nodes: [], refs: {} } });
      await runArgs("keys", "Enter", "--tab", "9", "--snapshot");
      const bodies = fetchSpy.mock.calls.map((c) => JSON.parse(String((c[1] as { body: string }).body)));
      expect(bodies[1].args).toEqual({ tabId: 9, interactiveOnly: true, settle: true });
    });

    it("a failed action does not take the follow-up snapshot", async () => {
      mockBridgeResponse({ ok: false, error: "nope", errorDetails: { code: "stale_ref", message: "nope", retryable: false } }, false, 400);
      await runArgs("click", "@e3", "--snapshot");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("snapshot --settle sends settle:true", async () => {
      await runArgs("snapshot", "--tab", "1", "--settle");
      expect(lastBody().args).toMatchObject({ tabId: 1, settle: true });
    });

    it("snapshot --no-wait sends waitForReady:false; default sends nothing", async () => {
      await runArgs("snapshot", "--tab", "1", "--no-wait");
      expect(lastBody().args).toMatchObject({ tabId: 1, waitForReady: false });
      await runArgs("snapshot", "--tab", "1");
      expect(lastBody().args.waitForReady).toBeUndefined();
    });

    it("--json prints the structured envelope instead", async () => {
      mockBridgeResponse({
        ok: true,
        data: { title: "T", url: "u", tabId: 1, nodeCount: 0, nodes: [], refs: {} }
      });
      await runArgs("snapshot", "--tab", "1", "--json");
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain('"refs"');
    });

    it("click routes a @ref positional to the ref arg", async () => {
      await runArgs("click", "@e3");
      expect(lastBody()).toEqual({ name: "chrome_click_element", args: { ref: "e3" } });
    });

    it("read/ax aliases print a deprecation notice on stderr", async () => {
      await runArgs("read", "--tab", "1");
      const err = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(err).toContain("deprecated");
    });

    it("snapshot --diff posts diff:true and prints only changes", async () => {
      mockBridgeResponse({
        ok: true,
        data: {
          title: "T", url: "u", tabId: 1, nodeCount: 1,
          nodes: [{ role: "button", name: "Save", ref: "e2" }],
          refs: {},
          prevText: "Page: T\nURL: u\nTab: 1\n\n- button \"Old\" [ref=e1]"
        }
      });
      await runArgs("snapshot", "--tab", "1", "--diff");
      expect(lastBody().args).toEqual({ tabId: 1, diff: true });
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain('+- button "Save" [ref=e2]');
      expect(out).toContain("removal");
    });
  });

  describe("wait / get / batch / skills (adoption-spec 3,5,6,7)", () => {
    it("wait with a selector positional posts chrome_wait", async () => {
      await runArgs("wait", ".results", "--tab", "42");
      expect(lastBody()).toEqual({
        name: "chrome_wait",
        args: { tabId: 42, selector: ".results" }
      });
    });

    it("wait @ref and --text/--url/--load route to the right condition", async () => {
      await runArgs("wait", "@e3");
      expect(lastBody().args).toMatchObject({ ref: "e3" });
      await runArgs("wait", "--text", "Welcome", "--tab", "1");
      expect(lastBody().args).toMatchObject({ text: "Welcome" });
      await runArgs("wait", "--load", "networkidle", "--tab", "1");
      expect(lastBody().args).toMatchObject({ load: "networkidle" });
    });

    it("wait <ms> sleeps locally without a tool call", async () => {
      const before = fetchSpy.mock.calls.length;
      await runArgs("wait", "5");
      expect(fetchSpy.mock.calls.length).toBe(before);
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain('"sleptMs":5');
    });

    it("get text @ref posts chrome_get and prints the bare value", async () => {
      mockBridgeResponse({ ok: true, data: { value: "hello world" } });
      await runArgs("get", "text", "@e12");
      expect(lastBody()).toEqual({ name: "chrome_get", args: { what: "text", ref: "e12" } });
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("hello world");
      expect(out).not.toContain("{"); // bare value, not JSON
    });

    it("get attr <selector> <name> posts attrName", async () => {
      mockBridgeResponse({ ok: true, data: { value: "/x" } });
      await runArgs("get", "attr", "a.link", "href", "--tab", "2");
      expect(lastBody().args).toEqual({ what: "attr", attrName: "href", selector: "a.link", tabId: 2 });
    });

    it("batch posts the commands array with bail default true", async () => {
      mockBridgeResponse({ ok: true, data: { results: [{ ok: true }], completed: 1, total: 1 } });
      await runArgs("batch", '[{"name":"chrome_navigate","args":{"url":"https://kushalsm.com"}}]');
      expect(lastBody()).toEqual({
        name: "chrome_batch",
        args: { commands: [{ name: "chrome_navigate", args: { url: "https://kushalsm.com" } }], bail: true }
      });
    });

    it("skills get core prints the inlined playbook", async () => {
      await runArgs("skills", "get", "core");
      const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("core loop");
      expect(out).toContain("snapshot");
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
    // Post-0.5.14: the CLI forwards --tabs as the raw comma-separated string
    // and the protocol parser (parseChromeGroupArgs) does the strict numeric
    // parsing. Was previously parsed CLI-side with .filter(Number.isFinite)
    // which silently dropped bad IDs.
    it("create posts action=create + name + raw tabs string (+ color)", async () => {
      await runArgs("group", "create", "research", "--tabs", "123,456,789", "--color", "cyan");
      expect(lastBody()).toEqual({
        name: "chrome_group",
        args: { action: "create", name: "research", tabIds: "123,456,789", color: "cyan" }
      });
    });

    it("create with --collapsed forwards the flag", async () => {
      await runArgs("group", "create", "later", "--tabs", "1", "--collapsed");
      expect(lastBody()).toEqual({
        name: "chrome_group",
        args: { action: "create", name: "later", tabIds: "1", collapsed: true }
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

    it("add posts action=add + name + raw tabs string", async () => {
      await runArgs("group", "add", "research", "--tabs", "1011");
      expect(lastBody()).toEqual({
        name: "chrome_group",
        args: { action: "add", name: "research", tabIds: "1011" }
      });
    });

    it("remove posts action=remove + raw tabs string (no name)", async () => {
      await runArgs("group", "remove", "--tabs", "456,789");
      expect(lastBody()).toEqual({
        name: "chrome_group",
        args: { action: "remove", tabIds: "456,789" }
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
        // 0.5.19: protocol parser runs CLI-side and tags the discriminated
        // raw wire: the discriminated kind is computed by the parser at each
        // boundary, not carried on the wire.
        args: { selector: "button.submit" }
      });
    });

    it("forwards --no-wait as an explicit fast click for refs, selectors and coordinates", async () => {
      for (const argv of [["@e3"], ["#go"], ["--x", "10", "--y", "20"]]) {
        await runArgs("click", ...argv, "--no-wait", "--tab", "9");
        expect(lastBody().args).toMatchObject({ waitForNavigation: false, tabId: 9 });
      }
    });

    it("forwards --tab", async () => {
      await runArgs("click", "--tab", "9", "#go");
      expect(lastBody().args).toEqual({ selector: "#go", tabId: 9 });
    });

    // 0.5.19 — coordinate click. No selector positional; --x and --y both required.
    it("posts coords-mode click when --x and --y are passed", async () => {
      await runArgs("click", "--tab", "42", "--x", "540", "--y", "320");
      expect(lastBody().args).toEqual({ x: 540, y: 320, tabId: 42 });
    });

    it("rejects --x without --y (and vice versa)", async () => {
      const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await runArgs("click", "--x", "10");
      // Either commander rejected at parse, OR the CLI-side protocol parse
      // threw invalid_arguments. In both cases exit(1) or exit(2) is the
      // signal. We just assert non-success — message is informational.
      expect(exitSpy).toHaveBeenCalled();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
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

    it("routes a @ref positional to the ref arg", async () => {
      await runArgs("fill", "@e7", "hello");
      expect(lastBody().args).toEqual({ ref: "e7", value: "hello" });
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
    it("rejects switch locally before contacting any browser", async () => {
      await runArgs("switch", "987654");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy.mock.calls.map((c) => c[0]).join("\n")).toContain("--tab 987654");
    });
  });

  describe("background recording failures", () => {
    it("saves partial frames but exits with an error when sampling stopped early", async () => {
      const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = mkdtempSync(join(tmpdir(), "chrome-relay-recording-test-"));
      try {
        mockBridgeResponse({ ok: true, data: {
          frames: [{ data: Buffer.from("saved frame").toString("base64"), timestamp: 1, width: 1, height: 1 }],
          frameCount: 1, durationMs: 10, mode: "sampled", captureError: "target disconnected"
        } });
        await runArgs("screencast", "stop", "--tab", "42", "--out", dir);
        expect(readFileSync(join(dir, "frame_0001.jpg"), "utf8")).toBe("saved frame");
        expect(exitSpy).toHaveBeenCalledWith(1);
        expect(stderrSpy.mock.calls.map((c) => c[0]).join("\n")).toContain("target disconnected");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
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
