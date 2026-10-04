// Which tabs have agent-requested network capture on (network-buffer.ts
// owns the set). Separate, side-effect-free module so other Network.enable
// users (settle.ts) can check it without importing the buffer's CDP event
// listeners.
export const networkCaptureTabs = new Set<number>();
