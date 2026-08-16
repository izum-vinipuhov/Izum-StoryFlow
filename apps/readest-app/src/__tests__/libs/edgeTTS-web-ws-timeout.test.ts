// Browser (and plain Node) WebSocket transport for Edge TTS: the wss path has
// no inactivity timeout. A silently-dropped or half-open connection — the
// browser extension / middlebox case — never fires 'error' or 'close', so the
// synthesis promise never settles: live playback wedges silent and the
// offline-audio download stalls at "0/0" forever. This mirrors the Tauri
// transport fix in #5230 for the browser branch.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { FakeWebSocket } = vi.hoisted(() => {
  type MessageEventLike = { data: unknown };

  class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    url: string;
    binaryType = 'blob';
    listeners: Record<string, ((event: unknown) => void)[]> = {};
    sent: string[] = [];
    closed = false;

    constructor(url: string) {
      this.url = url;
      FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, cb: (event: unknown) => void) {
      (this.listeners[type] ??= []).push(cb);
    }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.closed = true;
      this.emit('close', {});
    }

    emit(type: string, event: unknown) {
      for (const cb of [...(this.listeners[type] ?? [])]) cb(event);
    }

    emitOpen() {
      this.emit('open', {});
    }

    emitMessage(data: unknown) {
      this.emit('message', { data } satisfies MessageEventLike);
    }
  }

  return { FakeWebSocket };
});

// edgeTTS holds its WebSocket as the default export of 'isomorphic-ws',
// bound at module load — stubbing the global is too late, so replace the
// module. The browser branch and the plain-Node branch share this path.
vi.mock('isomorphic-ws', () => ({ default: FakeWebSocket }));

vi.mock('@/services/environment', async () => {
  const actual =
    await vi.importActual<typeof import('@/services/environment')>('@/services/environment');
  return { ...actual, isTauriAppPlatform: () => false };
});

import { EdgeSpeechTTS, type EdgeTTSPayload } from '@/libs/edgeTTS';

const makePayload = (text: string): EdgeTTSPayload => ({
  lang: 'en',
  text,
  voice: 'en-US-AriaNeural',
  rate: 1.0,
  pitch: 1.0,
});

// The transport awaits crypto.subtle.digest (Sec-MS-GEC), which can resolve
// on macrotasks; drain both micro- and macrotasks.
const flushTasks = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// Resolves to 'pending' when `p` has not settled by the end of the current
// microtask drain — the pre-fix hang manifests as 'pending', not a timeout.
const settleState = (p: Promise<unknown>) =>
  Promise.race([
    p.then(
      () => 'resolved',
      () => 'rejected',
    ),
    flushTasks().then(() => 'pending'),
  ]);

describe('EdgeSpeechTTS browser WebSocket transport', () => {
  let ws: InstanceType<typeof FakeWebSocket>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Wraps the request promise: returning it bare would make `await` adopt it,
  // hanging the test whenever the promise (correctly or not) never settles.
  const startRequest = async (text: string) => {
    const tts = new EdgeSpeechTTS('wss');
    const promise = tts.createAudioData(makePayload(text));
    promise.catch(() => {});
    await vi.waitFor(() => {
      ws = FakeWebSocket.instances[0]!;
      expect(ws).toBeDefined();
    });
    return { promise };
  };

  test('rejects after prolonged silence when the socket never opens', async () => {
    vi.useFakeTimers();
    const { promise } = await startRequest('never opens sentence');
    // The socket silently never opens: no 'error', no 'close'. Before the
    // fix this hangs forever ('pending').
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settleState(promise)).toBe('rejected');
    await expect(promise).rejects.toThrow(/timed out/i);
  });

  test('rejects after prolonged silence on an open socket with no frames', async () => {
    vi.useFakeTimers();
    const { promise } = await startRequest('half-open socket sentence');
    ws.emitOpen();
    await flushTasks();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await settleState(promise)).toBe('rejected');
    await expect(promise).rejects.toThrow(/timed out/i);
  });

  test('rejects when the server closes before turn.end', async () => {
    const { promise } = await startRequest('close before turn.end');
    ws.emitOpen();
    await flushTasks();
    ws.close();
    expect(await settleState(promise)).toBe('rejected');
  });

  test('still resolves audio and boundaries on a normal turn.end flow', async () => {
    const { promise } = await startRequest('happy path sentence');
    ws.emitOpen();
    await flushTasks();
    // Binary frame: 2-byte big-endian header length (0) + audio payload.
    const binary = new Uint8Array([0, 0, 9, 8, 7, 6]);
    ws.emitMessage(binary.buffer);
    ws.emitMessage(
      'Path: audio.metadata\r\n\r\n{"Metadata":[{"Type":"WordBoundary","Data":{"Offset":1000000,"Duration":2000000,"text":{"Text":"happy"}}}]}',
    );
    ws.emitMessage('Path: turn.end\r\n\r\n');
    const { data, boundaries } = await promise;
    expect(new Uint8Array(data)).toEqual(new Uint8Array([9, 8, 7, 6]));
    expect(boundaries).toEqual([{ offset: 1000000, duration: 2000000, text: 'happy' }]);
    expect(ws.closed).toBe(true);
  });

  test('streaming frames reset the inactivity timer', async () => {
    vi.useFakeTimers();
    const { promise } = await startRequest('long streaming sentence');
    ws.emitOpen();
    await flushTasks();
    // 29s of silence, then a frame: the timer must re-arm, so the connection
    // survives well past 30s from open as long as frames keep flowing.
    await vi.advanceTimersByTimeAsync(29_000);
    ws.emitMessage(new Uint8Array([0, 0, 1, 2]).buffer);
    await vi.advanceTimersByTimeAsync(20_000);
    ws.emitMessage('Path: turn.end\r\n\r\n');
    const { data } = await promise;
    expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2]));
  });
});
