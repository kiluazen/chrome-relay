// In-page functions — serialized via evalInTab and executed in the page's
// MAIN world. Everything here must be self-contained (no imports, no
// closures over module scope).
//
// readPageSnapshot and its CSS-selector-path builder lived here until the
// unified snapshot (adoption-spec Change 1) replaced them — element identity
// is now the ref map (refs.ts) + backendNodeIds, not generated selectors.

// Cursor-interactive sweep (adoption-spec Change 1) — finds clickables the
// AX tree misses: cursor-pointer div-soup, onclick attributes, tabindex,
// contenteditable. Measured necessity: autark.sh's email rows are 37
// cursor-pointer spans/divs with no role; pure AX filtering hides them all
// (dash.cloudflare.com, by contrast, measured 0 — it's semantically clean).
//
// Returns the matching elements themselves (the caller evaluates this with
// returnByValue:false and resolves each element's backendNodeId through
// CDP), so the sweep never writes to the page's DOM: no attribute churn for
// MutationObservers to react to, nothing to clean up. Dedupe is "topmost
// clickable": cursor:pointer inherits, so descendants of a match are
// skipped (ancestors come first in document order), as are wrappers around
// native interactive elements. `scope` bounds the sweep to one subtree.
export function findCursorInteractive(maxItems: number, scope?: Element | null) {
  const NATIVE =
    "a,button,input,select,textarea,summary," +
    "[role=button],[role=link],[role=menuitem],[role=tab],[role=checkbox]," +
    "[role=combobox],[role=option],[role=switch],[role=radio],[role=textbox]";
  const candidates = scope
    ? [scope, ...Array.from(scope.querySelectorAll("*"))]
    : Array.from(document.querySelectorAll("*"));
  const picked = new Set<Element>();
  const out: HTMLElement[] = [];
  for (const el of candidates) {
    if (out.length >= maxItems) break;
    if (!(el instanceof HTMLElement)) continue;
    if (el.matches(NATIVE)) continue;
    const otherClickable =
      el.hasAttribute("onclick") || el.tabIndex >= 0 || el.isContentEditable;
    const style = window.getComputedStyle(el);
    if (style.cursor !== "pointer" && !otherClickable) continue;
    if (style.display === "none" || style.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 3 || rect.height < 3) continue;
    if (el.closest(NATIVE)) continue;
    let covered = false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (picked.has(p)) { covered = true; break; }
    }
    if (covered) continue;
    if (el.querySelector("a,button,input,select,textarea,summary")) continue;
    picked.add(el);
    out.push(el);
  }
  return out;
}

// Per-element label for sweep results: tag + trimmed visible text.
export function describeSweepElements(elements: Element[]) {
  return elements.map((el) => ({
    tag: el.tagName.toLowerCase(),
    text: ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80)
  }));
}

export function locateForClick(selector: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Element not found for selector: ${selector}`);
  }

  element.scrollIntoView({ block: "center", inline: "center" });
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    throw new Error(`Element has zero size and cannot be clicked: ${selector}`);
  }

  return {
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

export function fillElement(selector: string, value: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Element not found for selector: ${selector}`);
  }

  if (element instanceof HTMLSelectElement) {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true, selector, valueLength: value.length, kind: "select" };
  }

  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    throw new Error(
      `Fill target is not an input, textarea, or select: ${selector}. Use chrome_type for contenteditable.`
    );
  }

  element.focus();

  // Native prototype setter — bypasses React's value tracker so onChange fires.
  const proto =
    element instanceof HTMLInputElement
      ? HTMLInputElement.prototype
      : HTMLTextAreaElement.prototype;
  const nativeSet = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (nativeSet) {
    nativeSet.call(element, value);
  } else {
    element.value = value;
  }

  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));

  return { filled: true, selector, valueLength: value.length, kind: "input" };
}

export function focusSelector(selector: string) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Element not found for selector: ${selector}`);
  }
  element.focus();
  if (document.activeElement !== element) {
    throw new Error(`Element could not be focused: ${selector}`);
  }
  return { focused: true, selector };
}
