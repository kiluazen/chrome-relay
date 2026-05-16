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

  const elements = Array.from(document.querySelectorAll("*"))
    .filter((element) => isVisible(element))
    .filter((element) => (interactiveOnly ? isInteractive(element) : true))
    .slice(0, 250)
    .map((element, index) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return {
        ref: `ref_${index + 1}`,
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role"),
        text: textFor(element),
        selector: makeSelector(element),
        interactive: isInteractive(element),
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
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
