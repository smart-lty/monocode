import { beforeEach, describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({
  live: 0,
  maxLive: 0,
  spawned: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../platform/tauri/fs", () => ({
  homeDir: async () => "/home/test",
}));
vi.mock("../../../integrations/harness/core/child", () => ({
  resolveCodexBinary: async () => ({ path: "/bin/codex" }),
  spawnChild: async (
    _id: string,
    _path: string,
    _args: string[],
    _cwd: string,
    account: { id: string },
  ) => {
    child.live += 1;
    child.maxLive = Math.max(child.maxLive, child.live);
    child.spawned.push(account.id);
  },
  watchChild: () => undefined,
  unwatchChild: () => {
    child.live = Math.max(0, child.live - 1);
  },
  killChild: async () => undefined,
}));
vi.mock("../../../integrations/harness/core/jsonRpc", () => ({
  JsonRpcClient: class {
    close() {}
    pushLine() {}
    respond() {
      return Promise.resolve();
    }
    notify() {
      return Promise.resolve();
    }
    async request(method: string) {
      if (method !== "account/rateLimits/read") return {};
      await new Promise((resolve) => setTimeout(resolve, 5));
      return {
        rateLimits: {
          primary: { usedPercent: 10, windowDurationMins: 300 },
        },
      };
    }
  },
}));

import { invoke } from "@tauri-apps/api/core";
import { loadAgentProxyUrl } from "./agentProxy";
vi.mock("./agentProxy", () => ({ loadAgentProxyUrl: vi.fn(() => null) }));

import { fetchClaudeRateLimits, fetchCodexRateLimits, fetchOpencodeGoRateLimits } from "./rateLimitsFetch";

describe("fetchCodexRateLimits", () => {
  beforeEach(() => {
    child.live = 0;
    child.maxLive = 0;
    child.spawned = [];
  });

  it("runs usage probes for different accounts one at a time", async () => {
    const results = await Promise.all([
      fetchCodexRateLimits("default"),
      fetchCodexRateLimits("account-work"),
      fetchCodexRateLimits("account-personal"),
    ]);

    expect(child.maxLive).toBe(1);
    expect(child.spawned).toEqual([
      "default",
      "account-work",
      "account-personal",
    ]);
    expect(results.map((result) => result.session?.usedPercent)).toEqual([
      10, 10, 10,
    ]);
  });
});

describe("usage proxy forwarding", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(loadAgentProxyUrl).mockReturnValue(null);
  });

  it.each([null, "http://127.0.0.1:7897"])("forwards the configured Claude proxy: %s", async (proxyUrl) => {
    vi.mocked(loadAgentProxyUrl).mockReturnValue(proxyUrl);
    vi.mocked(invoke).mockResolvedValue({ status: "unavailable" });
    await fetchClaudeRateLimits("work");
    expect(invoke).toHaveBeenCalledWith("fetch_claude_usage", {
      accountId: "work",
      ...(proxyUrl ? { proxyUrl } : {}),
    });
  });
});

it("routes OpenCode Go usage through the configured proxy", async () => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({ status: "unavailable" });
  vi.mocked(loadAgentProxyUrl).mockReturnValue("http://127.0.0.1:7897");
  await fetchOpencodeGoRateLimits();
  expect(invoke).toHaveBeenCalledWith("fetch_opencode_go_usage", {
    proxyUrl: "http://127.0.0.1:7897",
  });
});
