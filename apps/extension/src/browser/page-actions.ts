export function readPageSnapshot(interactiveOnly: boolean) {
  const isVisible = (element: Element): element is HTMLElement => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom >= 0 &&
      rect.right >= 0 &&
      rect.top <= window.innerHeight &&
      rect.left <= window.innerWidth
    );
  };

  const isInteractive = (element: Element): boolean => {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const tagName = element.tagName.toLowerCase();
    const role = element.getAttribute("role");
    const interactiveTags = new Set([
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "summary"
    ]);
    if (interactiveTags.has(tagName)) {
      return true;
    }

    if (role && ["button", "link", "textbox", "checkbox", "menuitem", "tab"].includes(role)) {
      return true;
    }

    return typeof element.onclick === "function" || element.tabIndex >= 0;
  };

  const makeSelector = (element: Element): string => {
    if (!(element instanceof HTMLElement)) {
      return element.tagName.toLowerCase();
    }

    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }

    const testId = element.getAttribute("data-testid");
    if (testId) {
      return `[data-testid="${CSS.escape(testId)}"]`;
    }

    const parts: string[] = [];
    let current: HTMLElement | null = element;
    while (current && parts.length < 5) {
      const tag = current.tagName.toLowerCase();
      const parent: HTMLElement | null = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }

      const siblings = (Array.from(parent.children) as Element[]).filter(
        (candidate) => candidate.tagName === current?.tagName
      );
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
      current = parent;
    }

    return parts.join(" > ");
  };

  const textFor = (element: Element): string => {
    if (!(element instanceof HTMLElement)) {
      return "";
    }

    const label =
      element.getAttribute("aria-label") ||
      element.getAttribute("title") ||
      element.innerText ||
      element.textContent ||
      "";
    return label.replace(/\s+/g, " ").trim().slice(0, 200);
  };

  // Read the *current* state of an interactive element. Returns an empty object
  // for non-interactive nodes and for interactive nodes that don't carry the
  // matching state (e.g. an <a> has no `value`).
  //
  // The point of this function — and why §2.8 of boundaries.md flagged it —
  // is so `read -i` answers "what does the form currently say?" not just
  // "what fields exist?". Halves the round-trips for form-fill verification.
  type ElementState = {
    value?: string;
    checked?: boolean;
    selected?: boolean;
    ariaPressed?: string;
    ariaExpanded?: string;
    ariaChecked?: string;
    ariaSelected?: string;
    disabled?: boolean;
    readonly?: boolean;
    required?: boolean;
    placeholder?: string;
  };

  const stateFor = (element: Element): ElementState => {
    if (!(element instanceof HTMLElement)) return {};
    const state: ElementState = {};

    // Native value carriers
    if (element instanceof HTMLInputElement) {
      const t = element.type.toLowerCase();
      if (t === "checkbox" || t === "radio") {
        state.checked = element.checked;
      } else {
        // password type is intentionally NOT redacted — caller already opted
        // into reading the DOM. Treat as input value like everything else.
        state.value = element.value;
      }
      if (element.placeholder) state.placeholder = element.placeholder;
      if (element.disabled) state.disabled = true;
      if (element.readOnly) state.readonly = true;
      if (element.required) state.required = true;
    } else if (element instanceof HTMLTextAreaElement) {
      state.value = element.value;
      if (element.placeholder) state.placeholder = element.placeholder;
      if (element.disabled) state.disabled = true;
      if (element.readOnly) state.readonly = true;
      if (element.required) state.required = true;
    } else if (element instanceof HTMLSelectElement) {
      state.value = element.value;
      if (element.disabled) state.disabled = true;
      if (element.required) state.required = true;
    } else if (element instanceof HTMLOptionElement) {
      state.selected = element.selected;
      state.value = element.value;
      if (element.disabled) state.disabled = true;
    } else if (element instanceof HTMLButtonElement) {
      if (element.disabled) state.disabled = true;
    }

    // ARIA mirrors — present even when the native attribute isn't.
    const ariaPressed  = element.getAttribute("aria-pressed");
    const ariaExpanded = element.getAttribute("aria-expanded");
    const ariaChecked  = element.getAttribute("aria-checked");
    const ariaSelected = element.getAttribute("aria-selected");
    if (ariaPressed  !== null) state.ariaPressed  = ariaPressed;
    if (ariaExpanded !== null) state.ariaExpanded = ariaExpanded;
    if (ariaChecked  !== null) state.ariaChecked  = ariaChecked;
    if (ariaSelected !== null) state.ariaSelected = ariaSelected;

    // aria-disabled on a non-form element (e.g. a div acting as a button).
    if (state.disabled === undefined && element.getAttribute("aria-disabled") === "true") {
      state.disabled = true;
    }

    return state;
  };

  const elements = Array.from(document.querySelectorAll("*"))
    .filter((element) => isVisible(element))
    .filter((element) => (interactiveOnly ? isInteractive(element) : true))
    .slice(0, 250)
    .map((element, index) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      const isInter = isInteractive(element);
      const node: {
        ref: string;
        tagName: string;
        role: string | null;
        text: string;
        selector: string;
        interactive: boolean;
        bounds: { x: number; y: number; width: number; height: number };
        state?: ElementState;
      } = {
        ref: `ref_${index + 1}`,
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        text: textFor(element),
        selector: makeSelector(element),
        interactive: isInter,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
      // Only attach `state` for interactive nodes (the common case where it
      // matters) and only when it has at least one entry — keeps the payload
      // tight for the non-form majority of pages.
      if (isInter) {
        const s = stateFor(element);
        if (Object.keys(s).length > 0) node.state = s;
      }
      return node;
    });

  return {
    title: document.title,
    url: location.href,
    elementCount: elements.length,
    elements
  };
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
