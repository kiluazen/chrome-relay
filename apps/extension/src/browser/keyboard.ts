import { send } from "./cdp";

interface KeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
}

const SPECIAL_KEYS: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  end: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 }
};

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8
};

function specForCharacter(char: string, modifiers: number): KeySpec {
  const upper = char.toUpperCase();
  const isLetter = /^[a-zA-Z]$/.test(char);
  const code = isLetter ? `Key${upper}` : char;
  const suppressText = (modifiers & (1 | 2 | 4)) !== 0;
  return {
    key: char,
    code,
    windowsVirtualKeyCode: upper.charCodeAt(0),
    text: suppressText ? undefined : char
  };
}

function resolveSpec(token: string, modifiers: number): KeySpec {
  const lookup = SPECIAL_KEYS[token.toLowerCase()];
  if (lookup) {
    return { ...lookup };
  }
  if (token.length === 1) {
    return specForCharacter(token, modifiers);
  }
  throw new Error(`Unknown key: "${token}". Use a single character, a named key (Enter, Tab, ArrowDown), or a chord like Cmd+K.`);
}

export async function pressKey(tabId: number, expression: string): Promise<void> {
  const tokens = expression.split("+").map((part) => part.trim()).filter(Boolean);
  if (tokens.length === 0) {
    throw new Error("Empty key expression.");
  }

  let modifiers = 0;
  for (const token of tokens.slice(0, -1)) {
    const bit = MODIFIER_BITS[token.toLowerCase()];
    if (bit === undefined) {
      throw new Error(`Unknown modifier: "${token}". Expected alt, ctrl, meta/cmd, or shift.`);
    }
    modifiers |= bit;
  }

  const spec = resolveSpec(tokens[tokens.length - 1], modifiers);

  const downType = spec.text ? "keyDown" : "rawKeyDown";
  await send(tabId, "Input.dispatchKeyEvent", {
    type: downType,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
    modifiers,
    ...(spec.text ? { text: spec.text, unmodifiedText: spec.text } : {})
  });

  await send(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.windowsVirtualKeyCode,
    nativeVirtualKeyCode: spec.windowsVirtualKeyCode,
    modifiers
  });
}
