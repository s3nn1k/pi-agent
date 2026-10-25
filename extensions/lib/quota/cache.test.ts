import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getQuotaEntry, refreshQuotas } from "./cache.ts";

process.env.ZAI_API_KEY = "test-key";

const ZAI_DOMAIN = "api.z.ai";
const CODEX_DOMAIN = "chatgpt.com";

const ZAI_USAGE = {
  data: {
    level: "max",
    limits: [
      { type: "TOKENS_LIMIT", unit: 6, percentage: 10 },
      { type: "TOKENS_LIMIT", unit: 3, percentage: 20 },
    ],
  },
};

const CODEX_USAGE = {
  rate_limit: {
    primary_window: { used_percent: 30, limit_window_seconds: 604_800 },
    secondary_window: { used_percent: 40, limit_window_seconds: 86_400 },
  },
};

const ctx = {
  modelRegistry: {
    getProviderAuthStatus: () => ({ configured: true }),
    getApiKeyForProvider: () => "header.payload.signature",
  },
} as unknown as ExtensionContext;

interface PendingFetch {
  resolve(response: unknown): void;
  reject(error: Error): void;
}

function installFetchStub(t: TestContext) {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const pending = new Map<string, PendingFetch>();

  function takeDeferred(domain: string): PendingFetch {
    const key = [...pending.keys()].find((url) => url.includes(domain));
    if (!key) throw new Error(`нет ожидающего fetch для ${domain}`);
    const deferred = pending.get(key);
    pending.delete(key);
    if (!deferred) throw new Error(`нет ожидающего fetch для ${domain}`);
    return deferred;
  }

  globalThis.fetch = ((url: string | URL, init?: RequestInit) => {
    const key = String(url);
    urls.push(key);
    return new Promise((resolve, reject) => {
      pending.set(key, { resolve, reject });
      init?.signal?.addEventListener(
        "abort",
        () => {
          pending.delete(key);
          reject(new Error("This operation was aborted"));
        },
        { once: true },
      );
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  return {
    callsTo(domain: string): number {
      return urls.filter((url) => url.includes(domain)).length;
    },
    resolve(domain: string, body: unknown): void {
      takeDeferred(domain).resolve({ ok: true, json: async () => body });
    },
    reject(domain: string, error: Error): void {
      takeDeferred(domain).reject(error);
    },
  };
}

async function nextEventLoopTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function windowPercent(providerId: string, label: string): number | undefined {
  return getQuotaEntry(providerId)?.snapshot.windows.find(
    (window) => window.label === label,
  )?.usedPercent;
}

describe("refreshQuotas", () => {
  it("конкурирующие refreshQuotas ждут одну загрузку: fetch по провайдеру один, оба получают snapshot", async (t) => {
    const stub = installFetchStub(t);
    const primed = refreshQuotas(ctx, undefined, { maxAgeMs: 0 });
    await nextEventLoopTurn();
    assert.equal(stub.callsTo(ZAI_DOMAIN), 1);
    assert.equal(stub.callsTo(CODEX_DOMAIN), 1);

    const routed = refreshQuotas(ctx, undefined, { maxAgeMs: 0 });
    let routedSettled = false;
    void routed.then(() => {
      routedSettled = true;
    });
    await nextEventLoopTurn();
    assert.equal(stub.callsTo(ZAI_DOMAIN), 1);
    assert.equal(stub.callsTo(CODEX_DOMAIN), 1);
    assert.equal(
      routedSettled,
      false,
      "второй refreshQuotas не должен разрешаться до завершения идущей загрузки",
    );

    stub.resolve(CODEX_DOMAIN, CODEX_USAGE);
    stub.resolve(ZAI_DOMAIN, ZAI_USAGE);
    await Promise.all([primed, routed]);
    assert.equal(stub.callsTo(ZAI_DOMAIN), 1);
    assert.equal(getQuotaEntry("zai")?.error, undefined);
    assert.equal(windowPercent("zai", "wk"), 10);
    assert.equal(windowPercent("zai", "5h"), 20);
  });

  it("отмена сессии: snapshot не перезаписывается, inFlight очищается, повторный refresh возможен", async (t) => {
    const stub = installFetchStub(t);
    const fetchedAtBefore = getQuotaEntry("zai")?.fetchedAtMs;
    const session = new AbortController();
    const refresh = refreshQuotas(ctx, session.signal, { maxAgeMs: 0 });
    await nextEventLoopTurn();
    assert.equal(stub.callsTo(ZAI_DOMAIN), 1);

    session.abort();
    await refresh;
    assert.equal(getQuotaEntry("zai")?.fetchedAtMs, fetchedAtBefore);
    assert.equal(getQuotaEntry("zai")?.error, undefined);

    const retry = refreshQuotas(ctx, undefined, { maxAgeMs: 0 });
    await nextEventLoopTurn();
    assert.equal(stub.callsTo(ZAI_DOMAIN), 2);
    stub.resolve(ZAI_DOMAIN, ZAI_USAGE);
    stub.resolve(CODEX_DOMAIN, CODEX_USAGE);
    await retry;
    assert.equal(windowPercent("zai", "wk"), 10);
    assert.equal(windowPercent("zai", "5h"), 20);
  });

  it("отказ загрузки: при keepOnError:false ошибка пишется, inFlight очищается, retry делает новый fetch", async (t) => {
    const stub = installFetchStub(t);
    const failed = refreshQuotas(ctx, undefined, { maxAgeMs: 0 });
    await nextEventLoopTurn();
    stub.reject(ZAI_DOMAIN, new Error("boom"));
    stub.resolve(CODEX_DOMAIN, CODEX_USAGE);
    await failed;
    assert.equal(getQuotaEntry("zai")?.error, "boom");

    const retry = refreshQuotas(ctx, undefined, { maxAgeMs: 0 });
    await nextEventLoopTurn();
    assert.equal(stub.callsTo(ZAI_DOMAIN), 2);
    stub.resolve(ZAI_DOMAIN, ZAI_USAGE);
    stub.resolve(CODEX_DOMAIN, CODEX_USAGE);
    await retry;
    assert.equal(getQuotaEntry("zai")?.error, undefined);
    assert.equal(windowPercent("zai", "wk"), 10);
    assert.equal(windowPercent("zai", "5h"), 20);
  });
});
