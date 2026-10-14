/** Pi's session id, or null when the context has none or reading it throws. */
export function sessionIdOf(ctx: unknown): string | null {
  try {
    const manager = (ctx as { sessionManager?: { getSessionId?: unknown } } | undefined)?.sessionManager;
    if (!manager || typeof manager.getSessionId !== 'function') return null;
    const id = (manager as { getSessionId(): unknown }).getSessionId();
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}
