import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { createRequire } from "node:module";

type Model = { provider: string; id: string; api: string };

const require = createRequire(import.meta.url);
const createJiti = require(
  new URL(
    "../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti",
    import.meta.url,
  ).pathname,
) as (
  filename: string,
  options: { interopDefault: boolean },
) => { import(path: string): Promise<unknown> };
const jiti = createJiti(new URL("./index.test.ts", import.meta.url).pathname, {
  interopDefault: true,
});
const { default: register } = (await jiti.import("./index.ts")) as {
  default(pi: unknown): void;
};
const cache = (await jiti.import("../lib/quota/cache.ts")) as {
  clearProviderBreaker(provider: string): void;
  isProviderBroken(provider: string): boolean;
  refreshQuotas(ctx: any, signal?: AbortSignal, options?: any): Promise<void>;
};

process.env.ZAI_API_KEY = "model-router-integration-test";

const models: Model[] = [
  ["zai", "glm-5.3", "openai-completions"],
  ["zai", "glm-5.3-flash", "openai-completions"],
  ["openai-codex", "gpt-6.1-sol", "openai-responses"],
  ["openai-codex", "gpt-5.6-luna", "openai-responses"],
].map(([provider, id, api]) => ({ provider, id, api }));
const model = (provider: string, id: string): Model =>
  models.find((entry) => entry.provider === provider && entry.id === id)!;
const virtual: Model = {
  provider: "router",
  id: "frontier",
  api: "pi-virtual",
};
const quota: Record<string, { wk: number; fh: number }> = {
  zai: { wk: 10, fh: 10 },
  "openai-codex": { wk: 10, fh: 10 },
};
const fetchCalls: string[] = [];
const notifications: string[] = [];
const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
const routes = new Map<string, any>();
const context: any = {
  model: virtual,
  modelRegistry: {
    find: (provider: string, id: string) => model(provider, id),
    getProviderAuthStatus: () => ({ configured: true }),
    getApiKeyForProvider: () => "header.payload.signature",
  },
  ui: { notify: (message: string) => notifications.push(message) },
};

register({
  registerVirtualModel(definition: any) {
    routes.set(definition.id, definition);
  },
  on(event: string, handler: (event: any, ctx: any) => unknown) {
    handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    return () => undefined;
  },
});

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  fetchCalls.push(url);
  const current = url.includes("api.z.ai") ? quota.zai : quota["openai-codex"];
  const body = url.includes("api.z.ai")
    ? {
        data: {
          limits: [
            { type: "TOKENS_LIMIT", unit: 3, percentage: current.fh },
            { type: "TOKENS_LIMIT", unit: 6, percentage: current.wk },
          ],
        },
      }
    : {
        rate_limit: {
          primary_window: {
            used_percent: current.wk,
            limit_window_seconds: 604_800,
          },
          secondary_window: {
            used_percent: current.fh,
            limit_window_seconds: 18_000,
          },
        },
      };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const emit = async (event: any, ctx: any = context): Promise<void> => {
  for (const handler of handlers.get(event.type) ?? [])
    await handler(event, ctx);
};
const route = async (
  reason: "continuation" | "retry" | "direct",
  previous?: Model,
): Promise<{ model: Model }> => {
  const definition = routes.get("frontier");
  assert.ok(definition);
  return definition.route(
    {
      model: virtual,
      thinkingLevel: "high",
      reason,
      ...(previous ? { previous: { model: previous } } : {}),
      messages: [],
    },
    context,
  );
};
const reset = async (): Promise<void> => {
  await emit({ type: "session_shutdown" });
  quota.zai = { wk: 10, fh: 10 };
  quota["openai-codex"] = { wk: 10, fh: 10 };
  fetchCalls.length = 0;
  notifications.length = 0;
  for (const provider of ["zai", "openai-codex", "router"]) {
    cache.clearProviderBreaker(provider);
  }
  await cache.refreshQuotas(context, undefined, {
    maxAgeMs: 0,
    keepOnError: true,
  });
  context.model = virtual;
};
const beginCodexCompaction = async (reason = "manual"): Promise<void> => {
  await emit({
    type: "session_before_compact",
    reason,
    willRetry: reason !== "manual",
  });
  assert.equal(
    (await route("direct", model("openai-codex", "gpt-6.1-sol"))).model
      .provider,
    "openai-codex",
  );
};
const failCompaction = async (
  reason = "manual",
  extra: any = {},
): Promise<void> => {
  await emit({
    type: "session_compact_failed",
    reason,
    errorMessage: "Summarization failed: usage limit",
    aborted: false,
    willRetry: reason !== "manual",
    fromExtension: false,
    ...extra,
  });
};

beforeEach(reset);

describe("registered model-router routes", { concurrency: false }, () => {
  it("routes direct compaction away from an exhausted latest Codex response", async () => {
    quota["openai-codex"] = { wk: 100, fh: 50 };
    await cache.refreshQuotas(context, undefined, {
      maxAgeMs: 0,
      keepOnError: true,
    });
    assert.equal(
      (await route("direct", model("openai-codex", "gpt-6.1-sol"))).model
        .provider,
      "zai",
    );
  });

  it("breaks the physical failed summary provider and routes the repeat elsewhere", async () => {
    await beginCodexCompaction();
    const callsBeforeFailure = fetchCalls.length;
    await failCompaction();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(cache.isProviderBroken("openai-codex"), true);
    assert.ok(fetchCalls.length > callsBeforeFailure);
    assert.ok(notifications.some((message) => message.includes("/compact")));
    assert.equal(
      (await route("direct", model("openai-codex", "gpt-6.1-sol"))).model
        .provider,
      "zai",
    );
    for (const reason of ["manual", "threshold"] as const) {
      await reset();
      await beginCodexCompaction(reason);
      await failCompaction(reason);
      assert.equal(cache.isProviderBroken("openai-codex"), true);
    }
  });

  it("never marks the virtual provider without route evidence", async () => {
    await emit({ type: "before_provider_request", payload: {} });
    await emit({ type: "after_provider_response", status: 429, headers: {} });
    assert.equal(cache.isProviderBroken("router"), false);
    assert.equal(cache.isProviderBroken("openai-codex"), false);
  });

  it("attributes HTTP 429 to a routed or physical provider, never router", async () => {
    assert.equal(
      (await route("continuation", model("openai-codex", "gpt-6.1-sol"))).model
        .provider,
      "openai-codex",
    );
    await emit({ type: "before_provider_request", payload: {} });
    await emit({ type: "after_provider_response", status: 429, headers: {} });
    assert.equal(cache.isProviderBroken("openai-codex"), true);
  });

  it("clears compaction attribution for terminal outcomes and unsafe failures", async () => {
    await beginCodexCompaction();
    await emit({ type: "session_compact" });
    await failCompaction();
    assert.equal(cache.isProviderBroken("openai-codex"), false);

    for (const extra of [
      { aborted: true },
      { fromExtension: true },
      { errorMessage: "network error" },
    ]) {
      await reset();
      await beginCodexCompaction();
      await failCompaction("manual", extra);
      assert.equal(cache.isProviderBroken("openai-codex"), false);
      assert.equal(notifications.length, 0);
    }

    await reset();
    await beginCodexCompaction();
    await emit({ type: "session_shutdown" });
    await failCompaction();
    assert.equal(cache.isProviderBroken("openai-codex"), false);

    await reset();
    await emit({ type: "session_before_compact", reason: "manual" });
    await failCompaction();
    assert.equal(cache.isProviderBroken("openai-codex"), false);
    assert.equal(notifications.length, 0);
  });
});
