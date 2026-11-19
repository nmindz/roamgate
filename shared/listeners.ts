/** Adds `listener` and returns its unsubscribe. */
export function addListener<T>(listeners: Set<T>, listener: T): () => boolean {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
