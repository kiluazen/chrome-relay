const PROTOCOL_VERSION = "1.3";

const attached = new Set<number>();
const inflightAttach = new Map<number, Promise<void>>();

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") {
    attached.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

function isAlreadyAttached(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Another debugger is already attached/i.test(message);
}

export async function ensureAttached(tabId: number): Promise<void> {
  if (attached.has(tabId)) {
    return;
  }

  const existing = inflightAttach.get(tabId);
  if (existing) {
    await existing;
    return;
  }

  const promise = (async () => {
    try {
      try {
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      } catch (err) {
        // Chrome reports "Another debugger is already attached" when its OS-level
        // view of the session disagrees with our in-memory `attached` Set. This
        // happens whenever cdp state goes out of sync — e.g. if our SW restarted
        // and the previous session is still live, or if another tool path attached
        // outside ensureAttached. chrome.debugger.detach succeeds only for the
        // extension that owns the session, so it doubles as an ownership probe:
        // if we own it, this clears the stale state; if someone else owns it
        // (DevTools, another extension), detach throws and we re-throw a clearer
        // error pointing the user at the right resolution.
        if (!isAlreadyAttached(err)) throw err;
        try {
          await chrome.debugger.detach({ tabId });
        } catch {
          throw new Error(
            `Tab ${tabId} is being debugged by Chrome DevTools or another ` +
              `extension. Close DevTools, detach the other extension, or use a ` +
              `different tab.`
          );
        }
        await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
      }
      attached.add(tabId);
    } finally {
      inflightAttach.delete(tabId);
    }
  })();

  inflightAttach.set(tabId, promise);
  await promise;
}

export async function send<T = unknown>(
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  await ensureAttached(tabId);
  const result = await chrome.debugger.sendCommand(
    { tabId },
    method,
    params
  );
  return result as T;
}

interface RuntimeEvaluateResponse<TResult> {
  result: { value?: TResult; type: string };
  exceptionDetails?: {
    text: string;
    exception?: { description?: string };
  };
}

export interface EvalOptions {
  userGesture?: boolean;
  timeout?: number;
}

export async function evalExpression<TResult = unknown>(
  tabId: number,
  expression: string,
  options: EvalOptions = {}
): Promise<{ value?: TResult; type: string }> {
  const response = await send<RuntimeEvaluateResponse<TResult>>(
    tabId,
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...options
    }
  );

  if (response.exceptionDetails) {
    const message =
      response.exceptionDetails.exception?.description ??
      response.exceptionDetails.text;
    throw new Error(message);
  }

  return response.result;
}

export async function evalInTab<TArgs extends unknown[], TResult>(
  tabId: number,
  fn: (...args: TArgs) => TResult,
  args: TArgs
): Promise<TResult> {
  const expression = `(${fn.toString()}).apply(null, ${JSON.stringify(args)})`;
  const result = await evalExpression<TResult>(tabId, expression);
  return result.value as TResult;
}
