import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestDeadline } from './request-deadline';

afterEach(() => vi.useRealTimers());
describe('startup request deadline', () => {
  it('aborts a stalled request and its response body after the deadline', async () => {
    vi.useFakeTimers();
    const deadline = requestDeadline(100);
    const abort = vi.fn();
    deadline.signal.addEventListener('abort', abort);
    await vi.advanceTimersByTimeAsync(99);
    expect(deadline.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason.name).toBe('TimeoutError');
    expect(abort).toHaveBeenCalledOnce();
  });
  it('cleans up successful requests without aborting them later', async () => {
    vi.useFakeTimers();
    const deadline = requestDeadline(100);
    deadline.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(deadline.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels outstanding requests when the page unmounts', () => {
    vi.useFakeTimers();
    const deadline = requestDeadline();
    deadline.cancel();
    expect(deadline.signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
