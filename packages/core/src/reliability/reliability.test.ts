import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConflictError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from '../provider/errors.js';
import { FakeSandboxProvider } from '../testing/index.js';
import {
  backoffDelayMs,
  exitCodeForError,
  exitCodeForFailure,
  failureCodeForError,
  isRateLimit,
  RacecarError,
  RetryingProvider,
  retryWithBackoff,
  runFailureCodeForExit,
  TimeoutError,
  withTimeout,
} from './index.js';

describe('failure codes', () => {
  it('maps provider errors to deterministic codes and exit codes', () => {
    expect(failureCodeForError(new ProviderRateLimitError('slow down'))).toBe('rate_limited');
    expect(failureCodeForError(new ProviderConflictError('busy'))).toBe('conflict');
    expect(failureCodeForError(new ProviderTimeoutError('slow'))).toBe('timeout');
    expect(failureCodeForError(new Error('anything'))).toBe('internal');
    expect(exitCodeForError(new ProviderRateLimitError('x'))).toBe(6);
    expect(exitCodeForFailure('timeout')).toBe(124);
    expect(exitCodeForFailure('run_failed')).toBe(1);
  });

  it('a RacecarError carries its own code through classification', () => {
    expect(failureCodeForError(new RacecarError('auth', 'no token'))).toBe('auth');
    expect(exitCodeForError(new TimeoutError('too slow'))).toBe(124);
  });

  it('classifies an agent exit code into a run failure code', () => {
    expect(runFailureCodeForExit(0)).toBe('ok');
    expect(runFailureCodeForExit(124)).toBe('timeout');
    expect(runFailureCodeForExit(137)).toBe('timeout');
    expect(runFailureCodeForExit(1)).toBe('run_failed');
  });
});

describe('retryWithBackoff', () => {
  it('retries rate-limit errors then succeeds, without real delay', async () => {
    let calls = 0;
    const sleep = vi.fn(() => Promise.resolve());
    const result = await retryWithBackoff(
      () => {
        calls += 1;
        if (calls < 3) return Promise.reject(new ProviderRateLimitError('429'));
        return Promise.resolve('ok');
      },
      { sleep, random: () => 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable error', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls += 1;
          return Promise.reject(new ProviderConflictError('conflict'));
        },
        { sleep: () => Promise.resolve() },
      ),
    ).rejects.toBeInstanceOf(ProviderConflictError);
    expect(calls).toBe(1);
  });

  it('gives up after the attempt cap and rethrows the rate-limit error', async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        () => {
          calls += 1;
          return Promise.reject(new ProviderRateLimitError('429'));
        },
        { maxAttempts: 3, sleep: () => Promise.resolve(), random: () => 0 },
      ),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(calls).toBe(3);
  });

  it('grows the delay exponentially and applies jitter', () => {
    expect(backoffDelayMs(1, { baseDelayMs: 100, jitter: 0, random: () => 0 })).toBe(100);
    expect(backoffDelayMs(2, { baseDelayMs: 100, jitter: 0, random: () => 0 })).toBe(200);
    expect(backoffDelayMs(3, { baseDelayMs: 100, jitter: 0, random: () => 0 })).toBe(400);
    expect(backoffDelayMs(10, { baseDelayMs: 100, maxDelayMs: 500, jitter: 0 })).toBe(500);
    // Full jitter with random()=1 removes the whole delay.
    expect(backoffDelayMs(3, { baseDelayMs: 100, jitter: 1, random: () => 1 })).toBe(0);
    expect(isRateLimit(new ProviderRateLimitError('x'))).toBe(true);
    expect(isRateLimit(new Error('x'))).toBe(false);
  });
});

describe('RetryingProvider', () => {
  it('retries a rate-limited provider call transparently', async () => {
    const inner = new FakeSandboxProvider();
    await inner.buildSnapshot({ name: 'snap', baseImage: 'node:24' });
    let attempts = 0;
    const flaky = inner.createSandbox.bind(inner);
    vi.spyOn(inner, 'createSandbox').mockImplementation(async (request) => {
      attempts += 1;
      if (attempts < 2) throw new ProviderRateLimitError('429');
      return flaky(request);
    });
    const provider = new RetryingProvider(inner, {
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    const sandbox = await provider.createSandbox({ snapshot: 'snap' });
    expect(attempts).toBe(2);
    expect(sandbox.state).toBe('started');
    expect(provider.name).toBe('fake');
  });
});

describe('withTimeout', () => {
  const scheduler = {
    setTimer: (fn: () => void) => {
      fn();
      return 0;
    },
    clearTimer: () => {},
  };

  it('rejects with a deterministic TimeoutError when the deadline wins', async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 10, { scheduler, label: 'op' })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    await expect(withTimeout(never, 10, { scheduler })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('resolves a fast operation and does not arm a timeout for ms<=0', async () => {
    await expect(withTimeout(Promise.resolve('done'), 0)).resolves.toBe('done');
    await expect(
      withTimeout(Promise.resolve('done'), 1000, {
        scheduler: { setTimer: () => 1, clearTimer: () => {} },
      }),
    ).resolves.toBe('done');
  });
});
