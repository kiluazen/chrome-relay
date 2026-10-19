// The person comes first in their own tab. A content script reports trusted
// keydown/pointerdown/wheel events; while the person is typing, clicking or
// scrolling in a tab, agent input to that tab waits until they pause, then
// goes ahead. If they keep going past HUMAN_MAX_WAIT_MS the agent gets a
// retryable `user_active` error instead of fighting them for the caret.
//
// CDP-dispatched input is trusted too, so the content script also sees the
// agent's own events. Reports that land while agent input is in flight, or
// just after, are dropped (AGENT_ECHO_MS).

import { RelayError } from "@chrome-relay/protocol";

export const HUMAN_INPUT_MESSAGE = "chrome-relay.human-input";
/** The person counts as active in a tab this long after their last input. */
export const HUMAN_QUIET_MS = 1_500;
/** Longest agent input waits for the person to pause before giving up. */
export const HUMAN_MAX_WAIT_MS = 8_000;
const AGENT_ECHO_MS = 400;
const POLL_MS = 100;

const lastHuman = new Map<number, number>();
const lastAgent = new Map<number, number>();
const agentInflight = new Map<number, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function noteHumanInput(tabId: number, at = Date.now()): void {
  if ((agentInflight.get(tabId) ?? 0) > 0) return;
  if (at - (lastAgent.get(tabId) ?? 0) < AGENT_ECHO_MS) return;
  lastHuman.set(tabId, at);
}

/** Bracket an agent input dispatch so its echo isn't taken for the person. */
export function agentInputStarted(tabId: number): void {
  agentInflight.set(tabId, (agentInflight.get(tabId) ?? 0) + 1);
  lastAgent.set(tabId, Date.now());
}

export function agentInputEnded(tabId: number): void {
  const n = (agentInflight.get(tabId) ?? 1) - 1;
  if (n > 0) agentInflight.set(tabId, n);
  else agentInflight.delete(tabId);
  lastAgent.set(tabId, Date.now());
}

/** Milliseconds since the person last used this tab, or null if never seen. */
export function humanIdleMs(tabId: number): number | null {
  const last = lastHuman.get(tabId);
  return last === undefined ? null : Date.now() - last;
}

export async function yieldToHuman(tabId: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    const last = lastHuman.get(tabId);
    if (last === undefined) return;
    const quietFor = Date.now() - last;
    if (quietFor >= HUMAN_QUIET_MS) return;
    if (Date.now() - start >= HUMAN_MAX_WAIT_MS) {
      throw new RelayError({
        code: "user_active",
        message:
          `The user is typing or clicking in tab ${tabId}. Waited ${HUMAN_MAX_WAIT_MS / 1000}s for them to pause. ` +
          `Retry in a few seconds, or work in another tab (navigate --new).`,
        phase: "yield_to_user",
        details: { tabId, waitedMs: Date.now() - start },
        retryable: true
      });
    }
    await sleep(Math.min(POLL_MS, HUMAN_QUIET_MS - quietFor));
  }
}

export function _resetHumanForTests(): void {
  lastHuman.clear();
  lastAgent.clear();
  agentInflight.clear();
}

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== HUMAN_INPUT_MESSAGE) return;
    const tabId = sender.tab?.id;
    if (typeof tabId === "number") noteHumanInput(tabId);
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    lastHuman.delete(tabId);
    lastAgent.delete(tabId);
    agentInflight.delete(tabId);
  });
}
