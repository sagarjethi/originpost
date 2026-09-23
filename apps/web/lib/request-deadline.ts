/** A bounded lifetime for a group of read-only startup requests. */
export function requestDeadline(milliseconds = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The server took too long to respond.', 'TimeoutError')), milliseconds);
  return {
    signal: controller.signal,
    dispose() { clearTimeout(timer); },
    cancel() { clearTimeout(timer); controller.abort(); },
  };
}
