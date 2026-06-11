// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  fillElement,
  focusSelector,
  locateForClick,
  markCursorInteractive,
  unmarkCursorInteractive
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

describe("markCursorInteractive / unmarkCursorInteractive", () => {
  // jsdom has no layout: getComputedStyle().cursor is "" by default, so we
  // drive clickability via inline cursor styles + onclick/tabindex attrs.
  function styleClickable(el: HTMLElement) {
    el.style.cursor = "pointer";
  }

  it("marks a cursor-pointer div and returns tag + trimmed text", () => {
    document.body.innerHTML = `<div id="card">  Open   thing  </div>`;
    const card = document.getElementById("card") as HTMLElement;
    makeRect(card, { width: 100, height: 30 });
    styleClickable(card);

    const items = markCursorInteractive(50);
    expect(items).toEqual([{ i: 0, tag: "div", text: "Open thing" }]);
    expect(card.getAttribute("data-cr-sweep")).toBe("0");
  });

  it("skips native interactive elements and their wrappers", () => {
    document.body.innerHTML = `
      <div id="wrap"><button>Real</button></div>
      <a id="link" href="#">link</a>
    `;
    // body.querySelectorAll, NOT document — patching html/body rects would
    // leak into later tests (elements persist across innerHTML resets).
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      makeRect(el as HTMLElement, { width: 100, height: 30 });
      styleClickable(el as HTMLElement);
    }
    const items = markCursorInteractive(50);
    expect(items).toEqual([]); // wrapper contains a button; link IS native
  });

  it("dedupes to the topmost clickable (children of a marked ancestor skip)", () => {
    document.body.innerHTML = `
      <div id="row"><span id="inner">child text</span></div>
    `;
    const row = document.getElementById("row") as HTMLElement;
    const inner = document.getElementById("inner") as HTMLElement;
    makeRect(row, { width: 200, height: 40 });
    makeRect(inner, { width: 100, height: 20 });
    styleClickable(row);
    styleClickable(inner); // cursor:pointer inherits in real pages

    const items = markCursorInteractive(50);
    expect(items.length).toBe(1);
    expect(row.hasAttribute("data-cr-sweep")).toBe(true);
    expect(inner.hasAttribute("data-cr-sweep")).toBe(false);
  });

  it("skips invisible and tiny elements", () => {
    document.body.innerHTML = `
      <div id="hidden">x</div>
      <div id="tiny">y</div>
    `;
    const hidden = document.getElementById("hidden") as HTMLElement;
    const tiny = document.getElementById("tiny") as HTMLElement;
    makeRect(hidden, { width: 100, height: 30 });
    hidden.style.display = "none";
    styleClickable(hidden);
    makeRect(tiny, { width: 2, height: 2 });
    styleClickable(tiny);

    expect(markCursorInteractive(50)).toEqual([]);
  });

  it("respects maxItems and counts tabindex/onclick as clickable", () => {
    document.body.innerHTML = `
      <div id="a" tabindex="0">a</div>
      <div id="b" onclick="void 0">b</div>
      <div id="c" tabindex="0">c</div>
    `;
    for (const el of Array.from(document.body.children)) {
      makeRect(el as HTMLElement, { width: 100, height: 30 });
    }
    const items = markCursorInteractive(2);
    expect(items.length).toBe(2);
  });

  it("unmark removes every sweep attribute", () => {
    document.body.innerHTML = `<div id="card">x</div>`;
    const card = document.getElementById("card") as HTMLElement;
    makeRect(card, { width: 100, height: 30 });
    card.style.cursor = "pointer";
    markCursorInteractive(50);
    expect(document.querySelectorAll("[data-cr-sweep]").length).toBe(1);
    unmarkCursorInteractive();
    expect(document.querySelectorAll("[data-cr-sweep]").length).toBe(0);
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
