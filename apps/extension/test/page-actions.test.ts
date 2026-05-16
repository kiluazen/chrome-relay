// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  readPageSnapshot,
  fillElement,
  focusSelector,
  locateForClick
} from "../src/browser/page-actions";

beforeEach(() => {
  document.body.innerHTML = "";
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
});

function makeRect(el: HTMLElement, rect: Partial<DOMRect>) {
  const full: DOMRect = {
    x: rect.x ?? 0,
    y: rect.y ?? 0,
    top: rect.top ?? rect.y ?? 0,
    left: rect.left ?? rect.x ?? 0,
    bottom: rect.bottom ?? (rect.y ?? 0) + (rect.height ?? 20),
    right: rect.right ?? (rect.x ?? 0) + (rect.width ?? 100),
    width: rect.width ?? 100,
    height: rect.height ?? 20,
    toJSON: () => ({})
  };
  el.getBoundingClientRect = () => full;
}

describe("readPageSnapshot", () => {
  it("returns title, url, elementCount, elements array", () => {
    document.title = "fixture page";
    document.body.innerHTML = `
      <button>One</button>
      <button>Two</button>
    `;
    document.querySelectorAll("button").forEach((b) => makeRect(b as HTMLElement, { width: 50, height: 20 }));

    const snap = readPageSnapshot(true);
    expect(snap.title).toBe("fixture page");
    expect(snap.url).toBe("http://localhost:3000/");
    expect(snap.elementCount).toBe(snap.elements.length);
    expect(snap.elements.every((el) => "ref" in el && "selector" in el && "tagName" in el)).toBe(true);
  });

  it("interactiveOnly=true filters to buttons/inputs/links/etc", () => {
    document.body.innerHTML = `
      <button>btn</button>
      <span>inert</span>
      <a href="#">link</a>
      <div>plain div</div>
      <input type="text" />
    `;
    document.querySelectorAll("*").forEach((el) => makeRect(el as HTMLElement, { width: 100, height: 20 }));

    const snap = readPageSnapshot(true);
    const tags = snap.elements.map((e) => e.tagName);
    expect(tags).toContain("button");
    expect(tags).toContain("a");
    expect(tags).toContain("input");
    expect(tags).not.toContain("span");
    expect(tags).not.toContain("div");
  });

  it("interactiveOnly=false includes non-interactive visible elements", () => {
    document.body.innerHTML = `<div id="x">hello</div>`;
    document.querySelectorAll("*").forEach((el) => makeRect(el as HTMLElement, { width: 100, height: 20 }));

    const snap = readPageSnapshot(false);
    const tags = snap.elements.map((e) => e.tagName);
    expect(tags).toContain("div");
  });

  it("filters out elements with display:none", () => {
    document.body.innerHTML = `
      <button>visible</button>
      <button style="display:none">hidden</button>
    `;
    document.querySelectorAll("button").forEach((b) => makeRect(b as HTMLElement, { width: 50, height: 20 }));

    const snap = readPageSnapshot(true);
    const texts = snap.elements.map((e) => e.text);
    expect(texts).toContain("visible");
    expect(texts).not.toContain("hidden");
  });

  it("filters out elements with zero size", () => {
    document.body.innerHTML = `<button>zero</button>`;
    const btn = document.querySelector("button") as HTMLElement;
    makeRect(btn, { width: 0, height: 0 });

    const snap = readPageSnapshot(true);
    expect(snap.elements).toHaveLength(0);
  });

  it("caps result at 250 elements", () => {
    let html = "";
    for (let i = 0; i < 400; i++) html += `<button>btn${i}</button>`;
    document.body.innerHTML = html;
    document.querySelectorAll("button").forEach((b) => makeRect(b as HTMLElement, { width: 50, height: 20 }));

    const snap = readPageSnapshot(true);
    expect(snap.elements.length).toBeLessThanOrEqual(250);
  });

  it("uses #id selector when element has id", () => {
    document.body.innerHTML = `<button id="submit-btn">Go</button>`;
    makeRect(document.querySelector("button") as HTMLElement, { width: 50, height: 20 });

    const snap = readPageSnapshot(true);
    expect(snap.elements[0].selector).toBe("#submit-btn");
  });

  it("uses [data-testid=...] selector when present", () => {
    document.body.innerHTML = `<button data-testid="tweetTextarea_0">x</button>`;
    makeRect(document.querySelector("button") as HTMLElement, { width: 50, height: 20 });

    const snap = readPageSnapshot(true);
    expect(snap.elements[0].selector).toBe('[data-testid="tweetTextarea_0"]');
  });

  it("falls back to nth-of-type path for anonymous elements", () => {
    document.body.innerHTML = `<form><button>a</button><button>b</button></form>`;
    document.querySelectorAll("button").forEach((b) => makeRect(b as HTMLElement, { width: 50, height: 20 }));

    const snap = readPageSnapshot(true);
    const second = snap.elements[1];
    expect(second.selector).toMatch(/button:nth-of-type\(2\)/);
  });

  it("collects aria-label as text", () => {
    document.body.innerHTML = `<button aria-label="Send tweet">x</button>`;
    makeRect(document.querySelector("button") as HTMLElement, { width: 50, height: 20 });

    const snap = readPageSnapshot(true);
    expect(snap.elements[0].text).toBe("Send tweet");
  });

  it("trims and slices long text", () => {
    document.body.innerHTML = `<button>${"a".repeat(500)}</button>`;
    makeRect(document.querySelector("button") as HTMLElement, { width: 50, height: 20 });

    const snap = readPageSnapshot(true);
    expect(snap.elements[0].text.length).toBeLessThanOrEqual(200);
  });

  it("includes role='textbox' as interactive even on a div", () => {
    document.body.innerHTML = `<div role="textbox" contenteditable="true">x</div>`;
    makeRect(document.querySelector("div") as HTMLElement, { width: 100, height: 20 });

    const snap = readPageSnapshot(true);
    expect(snap.elements.some((e) => e.tagName === "div" && e.interactive)).toBe(true);
  });

  it("element bounds are integer-rounded", () => {
    document.body.innerHTML = `<button>x</button>`;
    makeRect(document.querySelector("button") as HTMLElement, { x: 10.7, y: 20.3, width: 50.5, height: 20.5 });

    const snap = readPageSnapshot(true);
    const b = snap.elements[0].bounds;
    expect(Number.isInteger(b.x)).toBe(true);
    expect(Number.isInteger(b.width)).toBe(true);
  });

  describe("state — value-aware read -i (§2.8)", () => {
    it("text input returns current value", () => {
      document.body.innerHTML = `<input id="n" type="text" value="hello" />`;
      makeRect(document.querySelector("input") as HTMLElement, { width: 200, height: 24 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ value: "hello" });
    });

    it("password input returns the value (we trust the caller)", () => {
      document.body.innerHTML = `<input id="p" type="password" value="secret" />`;
      makeRect(document.querySelector("input") as HTMLElement, { width: 200, height: 24 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ value: "secret" });
    });

    it("checkbox returns checked", () => {
      document.body.innerHTML = `
        <input id="c1" type="checkbox" checked />
        <input id="c2" type="checkbox" />
      `;
      document.querySelectorAll("input").forEach((i) => makeRect(i as HTMLElement, { width: 20, height: 20 }));
      const snap = readPageSnapshot(true);
      const c1 = snap.elements.find((e) => (e as any).selector === "#c1") as any;
      const c2 = snap.elements.find((e) => (e as any).selector === "#c2") as any;
      expect(c1.state).toMatchObject({ checked: true });
      expect(c2.state).toMatchObject({ checked: false });
    });

    it("radio returns checked", () => {
      document.body.innerHTML = `<input id="r" type="radio" name="g" checked />`;
      makeRect(document.querySelector("input") as HTMLElement, { width: 20, height: 20 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ checked: true });
    });

    it("textarea returns value", () => {
      document.body.innerHTML = `<textarea id="ta">multi
line</textarea>`;
      makeRect(document.querySelector("textarea") as HTMLElement, { width: 200, height: 80 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ value: "multi\nline" });
    });

    it("select returns current value", () => {
      document.body.innerHTML = `
        <select id="s">
          <option value="us">US</option>
          <option value="in" selected>India</option>
        </select>`;
      makeRect(document.querySelector("select") as HTMLElement, { width: 200, height: 32 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ value: "in" });
    });

    it("disabled input is flagged", () => {
      document.body.innerHTML = `<input id="d" type="text" disabled value="x" />`;
      makeRect(document.querySelector("input") as HTMLElement, { width: 200, height: 24 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ disabled: true });
    });

    it("readonly + required input are flagged", () => {
      document.body.innerHTML = `<input id="r" type="text" readonly required value="x" />`;
      makeRect(document.querySelector("input") as HTMLElement, { width: 200, height: 24 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ readonly: true, required: true });
    });

    it("placeholder is included when present", () => {
      document.body.innerHTML = `<input id="p" type="text" placeholder="your name" />`;
      makeRect(document.querySelector("input") as HTMLElement, { width: 200, height: 24 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ placeholder: "your name", value: "" });
    });

    it("aria-pressed on a button-as-toggle", () => {
      document.body.innerHTML = `<button id="t" aria-pressed="true">Bold</button>`;
      makeRect(document.querySelector("button") as HTMLElement, { width: 50, height: 24 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ ariaPressed: "true" });
    });

    it("aria-expanded on a disclosure trigger", () => {
      document.body.innerHTML = `<button id="d" aria-expanded="false">Menu</button>`;
      makeRect(document.querySelector("button") as HTMLElement, { width: 50, height: 24 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ ariaExpanded: "false" });
    });

    it("aria-disabled on a div-acting-as-button", () => {
      document.body.innerHTML = `<div role="button" tabindex="0" aria-disabled="true">Save</div>`;
      makeRect(document.querySelector("div") as HTMLElement, { width: 60, height: 24 });
      const snap = readPageSnapshot(true);
      expect(snap.elements[0].state).toMatchObject({ disabled: true });
    });

    it("non-interactive nodes have no state field at all", () => {
      document.body.innerHTML = `<p id="p">just text</p>`;
      makeRect(document.querySelector("p") as HTMLElement, { width: 200, height: 24 });
      const snap = readPageSnapshot(false);
      const p = snap.elements[0] as any;
      expect(p.state).toBeUndefined();
    });

    it("interactive nodes with no state don't carry an empty object", () => {
      document.body.innerHTML = `<a href="#">link</a>`;
      makeRect(document.querySelector("a") as HTMLElement, { width: 100, height: 24 });
      const snap = readPageSnapshot(true);
      const a = snap.elements[0] as any;
      // <a> has no value/checked/disabled in our model. No noise field.
      expect(a.state).toBeUndefined();
    });
  });
});

describe("fillElement", () => {
  it("writes plain input value and dispatches input + change", () => {
    document.body.innerHTML = `<input id="i" type="text" />`;
    const input = document.querySelector("input") as HTMLInputElement;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => events.push("change"));

    const result = fillElement("#i", "hello");

    expect(input.value).toBe("hello");
    expect(events).toEqual(["input", "change"]);
    expect(result).toMatchObject({ filled: true, kind: "input", valueLength: 5 });
  });

  it("uses native HTMLInputElement setter to bypass React tracker", () => {
    document.body.innerHTML = `<input id="i" type="text" />`;
    const input = document.querySelector("input") as HTMLInputElement;

    // Override the setter to detect direct assignments.
    let directAssign = 0;
    Object.defineProperty(input, "value", {
      set() {
        directAssign++;
      },
      get() {
        return "";
      },
      configurable: true
    });

    fillElement("#i", "react-bypassed");

    expect(directAssign).toBe(0);
  });

  it("textarea uses native HTMLTextAreaElement setter", () => {
    document.body.innerHTML = `<textarea id="t"></textarea>`;
    const ta = document.querySelector("textarea") as HTMLTextAreaElement;
    const result = fillElement("#t", "long form text\nsecond line");
    expect(ta.value).toBe("long form text\nsecond line");
    expect(result.kind).toBe("input");
  });

  it("select sets value and dispatches change", () => {
    document.body.innerHTML = `
      <select id="s">
        <option value="us">US</option>
        <option value="in">India</option>
      </select>`;
    const sel = document.querySelector("select") as HTMLSelectElement;
    const events: string[] = [];
    sel.addEventListener("change", () => events.push("change"));

    const result = fillElement("#s", "in");

    expect(sel.value).toBe("in");
    expect(events).toEqual(["change"]);
    expect(result).toMatchObject({ kind: "select" });
  });

  it("throws if element not found", () => {
    expect(() => fillElement("#missing", "x")).toThrow(/Element not found/);
  });

  it("error message points to chrome_type for non-fillable elements", () => {
    document.body.innerHTML = `<div id="rich" contenteditable="true"></div>`;
    expect(() => fillElement("#rich", "x")).toThrow(/chrome_type/);
  });
});

describe("focusSelector", () => {
  it("focuses the matched input", () => {
    document.body.innerHTML = `<input id="x" />`;
    const result = focusSelector("#x");
    expect(document.activeElement?.id).toBe("x");
    expect(result).toEqual({ focused: true, selector: "#x" });
  });

  it("throws when element not found", () => {
    expect(() => focusSelector("#nope")).toThrow(/Element not found/);
  });

  it("throws when element refuses focus (non-focusable)", () => {
    // jsdom won't move activeElement to a plain <p>
    document.body.innerHTML = `<p id="p">x</p>`;
    expect(() => focusSelector("#p")).toThrow(/could not be focused/);
  });
});

describe("locateForClick", () => {
  it("returns center coords + size for a normal element", () => {
    document.body.innerHTML = `<button id="b">x</button>`;
    const btn = document.querySelector("button") as HTMLButtonElement;
    makeRect(btn, { x: 100, y: 50, width: 80, height: 24 });
    btn.scrollIntoView = () => {};

    const r = locateForClick("#b");
    expect(r).toEqual({ x: 140, y: 62, width: 80, height: 24 });
  });

  it("rounds non-integer coords", () => {
    document.body.innerHTML = `<button id="b">x</button>`;
    const btn = document.querySelector("button") as HTMLButtonElement;
    makeRect(btn, { x: 10.4, y: 20.6, width: 50.4, height: 30.6 });
    btn.scrollIntoView = () => {};

    const r = locateForClick("#b");
    expect(Number.isInteger(r.x)).toBe(true);
    expect(Number.isInteger(r.y)).toBe(true);
  });

  it("throws on missing element", () => {
    expect(() => locateForClick("#nope")).toThrow(/Element not found/);
  });

  it("throws on zero-size element", () => {
    document.body.innerHTML = `<button id="b">x</button>`;
    const btn = document.querySelector("button") as HTMLButtonElement;
    makeRect(btn, { width: 0, height: 0 });
    btn.scrollIntoView = () => {};

    expect(() => locateForClick("#b")).toThrow(/zero size/);
  });
});
