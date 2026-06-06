import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock node:https — factory returns a request fn + Agent class
// ---------------------------------------------------------------------------
const mockHttpsRequest = vi.fn();
vi.mock("node:https", () => ({
  default: {
    request: (...args: unknown[]) => mockHttpsRequest(...args),
    Agent: class MockAgent {
      socket: unknown;
      rejectUnauthorized: boolean;
      constructor(opts: { socket: unknown; rejectUnauthorized: boolean }) {
        this.socket = opts.socket;
        this.rejectUnauthorized = opts.rejectUnauthorized;
      }
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock node:http
// ---------------------------------------------------------------------------
const mockHttpRequest = vi.fn();
vi.mock("node:http", () => ({
  default: {
    request: (...args: unknown[]) => mockHttpRequest(...args),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock for http.ClientRequest / https.ClientRequest */
function makeMockReq() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  });
}

/** Minimal mock for http.IncomingMessage. Does NOT auto-emit events.
 *  Call `emitBody(res)` after the callback has fired to push data + end. */
function makeMockRes(opts: {
  statusCode?: number;
  statusMessage?: string;
  headers?: Record<string, string | string[]>;
}) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    statusCode: opts.statusCode ?? 200,
    statusMessage: opts.statusMessage ?? "OK",
    headers: opts.headers ?? {},
  });
}

/** Emit body data and end on a mock response after a setTimeout(0) to let
 *  the ReadableStream's start() callback register listeners first. */
function emitBody(res: EventEmitter, body = "") {
  setTimeout(() => {
    if (body) res.emit("data", Buffer.from(body));
    res.emit("end");
  }, 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proxyFetch", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockHttpsRequest.mockReset();
    mockHttpRequest.mockReset();
    // Clear proxy env vars
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
  });

  afterEach(() => {
    delete process.env.HTTPS_PROXY;
    delete process.env.HTTP_PROXY;
    delete process.env.https_proxy;
    delete process.env.http_proxy;
  });

  async function loadModule() {
    return await import("@/server/proxy-fetch");
  }

  // -----------------------------------------------------------------------
  // Direct path (no proxy)
  // -----------------------------------------------------------------------

  describe("direct path (no proxy)", () => {
    beforeEach(() => {
      // Mock platform to non-darwin so getSystemProxyMac returns null
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    });

    it("makes https.request with correct options for a GET", async () => {
      const mockReq = makeMockReq();
      const mockRes = makeMockRes({ statusCode: 200 });

      mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        queueMicrotask(() => {
          cb(mockRes);
          emitBody(mockRes, "hello");
        });
        return mockReq;
      });

      const { proxyFetch } = await loadModule();
      const res = await proxyFetch("https://api.example.com:8443/v1/chat?model=gpt");

      expect(mockHttpsRequest).toHaveBeenCalledOnce();
      const opts = mockHttpsRequest.mock.calls[0][0];
      expect(opts.hostname).toBe("api.example.com");
      expect(opts.port).toBe(8443);
      expect(opts.path).toBe("/v1/chat?model=gpt");
      expect(opts.method).toBe("GET");
      expect(opts.family).toBe(4);

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("hello");
    });

    it("uses POST method and sends body with Content-Length", async () => {
      const mockReq = makeMockReq();
      const mockRes = makeMockRes({ statusCode: 201 });

      mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        queueMicrotask(() => {
          cb(mockRes);
          emitBody(mockRes, "{}");
        });
        return mockReq;
      });

      const { proxyFetch } = await loadModule();
      const body = JSON.stringify({ prompt: "hello" });
      await proxyFetch("https://api.example.com/v1/messages", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      });

      const opts = mockHttpsRequest.mock.calls[0][0];
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      expect(opts.headers["Content-Length"]).toBe(String(Buffer.byteLength(body)));

      expect(mockReq.write).toHaveBeenCalledWith(Buffer.from(body, "utf-8"));
      expect(mockReq.end).toHaveBeenCalled();
    });

    it("does not override an explicit Content-Length header", async () => {
      const mockReq = makeMockReq();
      const mockRes = makeMockRes({});

      mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        queueMicrotask(() => {
          cb(mockRes);
          emitBody(mockRes);
        });
        return mockReq;
      });

      const { proxyFetch } = await loadModule();
      await proxyFetch("https://example.com/api", {
        method: "POST",
        body: "data",
        headers: { "Content-Length": "999" },
      });

      const opts = mockHttpsRequest.mock.calls[0][0];
      expect(opts.headers["Content-Length"]).toBe("999");
    });

    it("defaults port to 443 when not specified", async () => {
      const mockReq = makeMockReq();
      const mockRes = makeMockRes({});

      mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        queueMicrotask(() => {
          cb(mockRes);
          emitBody(mockRes);
        });
        return mockReq;
      });

      const { proxyFetch } = await loadModule();
      await proxyFetch("https://example.com/path");

      const opts = mockHttpsRequest.mock.calls[0][0];
      expect(opts.port).toBe(443);
    });

    it("rejects when https.request emits an error", async () => {
      const mockReq = makeMockReq();

      mockHttpsRequest.mockImplementation((_opts: unknown, _cb: unknown) => {
        queueMicrotask(() => mockReq.emit("error", new Error("connection refused")));
        return mockReq;
      });

      const { proxyFetch } = await loadModule();
      await expect(proxyFetch("https://example.com/api")).rejects.toThrow("connection refused");
    });

    it("destroys request when signal aborts", async () => {
      const mockReq = makeMockReq();
      // Never resolve the request; we just check destroy is called
      mockHttpsRequest.mockImplementation(() => mockReq);

      const { proxyFetch } = await loadModule();
      const controller = new AbortController();

      // Don't await; just fire and check side-effects
      const promise = proxyFetch("https://example.com/api", { signal: controller.signal });

      controller.abort();
      expect(mockReq.destroy).toHaveBeenCalled();

      // Clean up: make the request error so the promise settles
      mockReq.emit("error", new Error("aborted"));
      await expect(promise).rejects.toThrow();
    });

    it("handles multi-value response headers", async () => {
      const mockReq = makeMockReq();
      const mockRes = makeMockRes({
        headers: { "set-cookie": ["a=1", "b=2"] },
      });

      mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        queueMicrotask(() => {
          cb(mockRes);
          emitBody(mockRes);
        });
        return mockReq;
      });

      const { proxyFetch } = await loadModule();
      const res = await proxyFetch("https://example.com/");

      expect(res.headers.get("set-cookie")).toBe("a=1, b=2");
    });
  });

  // -----------------------------------------------------------------------
  // Proxy path
  // -----------------------------------------------------------------------

  describe("proxy path", () => {
    it("creates HTTP CONNECT tunnel and sends HTTPS through socket", async () => {
      process.env.HTTPS_PROXY = "http://proxy.local:8080";

      // Mock the CONNECT tunnel (http.request)
      const connectReq = makeMockReq();
      const fakeSocket = new EventEmitter();
      mockHttpRequest.mockImplementation((_opts: unknown) => {
        queueMicrotask(() => connectReq.emit("connect", {}, fakeSocket));
        return connectReq;
      });

      // Mock the HTTPS request through the tunnel
      const httpsReq = makeMockReq();
      const httpsRes = makeMockRes({ statusCode: 200 });
      mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        queueMicrotask(() => {
          cb(httpsRes);
          emitBody(httpsRes, '{"ok":true}');
        });
        return httpsReq;
      });

      const { proxyFetch } = await loadModule();
      const res = await proxyFetch("https://api.example.com/v1/messages");

      // Verify CONNECT request to proxy
      expect(mockHttpRequest).toHaveBeenCalledOnce();
      const connectOpts = mockHttpRequest.mock.calls[0][0];
      expect(connectOpts.hostname).toBe("proxy.local");
      expect(connectOpts.port).toBe(8080);
      expect(connectOpts.method).toBe("CONNECT");
      expect(connectOpts.path).toBe("api.example.com:443");

      // Verify HTTPS request through tunnel
      expect(mockHttpsRequest).toHaveBeenCalledOnce();
      const httpsOpts = mockHttpsRequest.mock.calls[0][0];
      expect(httpsOpts.hostname).toBe("api.example.com");
      expect(httpsOpts.port).toBe(443);
      expect(httpsOpts.path).toBe("/v1/messages");
      expect(httpsOpts.agent).toBeDefined();
      expect(httpsOpts.agent.socket).toBe(fakeSocket);

      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe('{"ok":true}');
    });

    it("rejects with timeout error when CONNECT takes too long", async () => {
      process.env.HTTPS_PROXY = "http://slow-proxy:3128";

      const connectReq = makeMockReq();
      mockHttpRequest.mockImplementation((_opts: unknown) => {
        queueMicrotask(() => connectReq.emit("timeout"));
        return connectReq;
      });

      const { proxyFetch } = await loadModule();
      await expect(proxyFetch("https://example.com/")).rejects.toThrow("Proxy CONNECT timeout");
      expect(connectReq.destroy).toHaveBeenCalled();
    });

    it("rejects when CONNECT request emits error", async () => {
      process.env.HTTP_PROXY = "http://bad-proxy:1080";

      const connectReq = makeMockReq();
      mockHttpRequest.mockImplementation((_opts: unknown) => {
        queueMicrotask(() => connectReq.emit("error", new Error("ECONNREFUSED")));
        return connectReq;
      });

      const { proxyFetch } = await loadModule();
      await expect(proxyFetch("https://example.com/")).rejects.toThrow("ECONNREFUSED");
    });

    it("destroys CONNECT request when signal aborts", async () => {
      process.env.HTTPS_PROXY = "http://proxy.local:8080";

      const connectReq = makeMockReq();
      mockHttpRequest.mockImplementation(() => connectReq);

      const { proxyFetch } = await loadModule();
      const controller = new AbortController();

      const promise = proxyFetch("https://example.com/", { signal: controller.signal });

      controller.abort();
      expect(connectReq.destroy).toHaveBeenCalled();

      // Settle the promise
      connectReq.emit("error", new Error("aborted"));
      await expect(promise).rejects.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Environment variable precedence
  // -----------------------------------------------------------------------

  describe("env var precedence", () => {
    /** Helper: set up proxy + https mocks that resolve immediately */
    function setupProxyMocks() {
      const connectReq = makeMockReq();
      const fakeSocket = new EventEmitter();
      mockHttpRequest.mockImplementation(() => {
        queueMicrotask(() => connectReq.emit("connect", {}, fakeSocket));
        return connectReq;
      });

      const httpsReq = makeMockReq();
      const httpsRes = makeMockRes({});
      mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        queueMicrotask(() => {
          cb(httpsRes);
          emitBody(httpsRes);
        });
        return httpsReq;
      });
    }

    it("prefers HTTPS_PROXY over all others", async () => {
      process.env.HTTPS_PROXY = "http://https-proxy:1111";
      process.env.HTTP_PROXY = "http://http-proxy:2222";
      process.env.https_proxy = "http://lower-https:3333";
      process.env.http_proxy = "http://lower-http:4444";

      setupProxyMocks();

      const { proxyFetch } = await loadModule();
      await proxyFetch("https://example.com/");

      const connectOpts = mockHttpRequest.mock.calls[0][0];
      expect(connectOpts.hostname).toBe("https-proxy");
      expect(connectOpts.port).toBe(1111);
    });

    it("falls back to HTTP_PROXY when HTTPS_PROXY is not set", async () => {
      process.env.HTTP_PROXY = "http://http-proxy:2222";

      setupProxyMocks();

      const { proxyFetch } = await loadModule();
      await proxyFetch("https://example.com/");

      const connectOpts = mockHttpRequest.mock.calls[0][0];
      expect(connectOpts.hostname).toBe("http-proxy");
      expect(connectOpts.port).toBe(2222);
    });

    it("falls back to https_proxy (lowercase) when upper-case not set", async () => {
      process.env.https_proxy = "http://lower-https:3333";

      setupProxyMocks();

      const { proxyFetch } = await loadModule();
      await proxyFetch("https://example.com/");

      const connectOpts = mockHttpRequest.mock.calls[0][0];
      expect(connectOpts.hostname).toBe("lower-https");
      expect(connectOpts.port).toBe(3333);
    });

    it("falls back to http_proxy (lowercase) as last env option", async () => {
      process.env.http_proxy = "http://lower-http:4444";

      setupProxyMocks();

      const { proxyFetch } = await loadModule();
      await proxyFetch("https://example.com/");

      const connectOpts = mockHttpRequest.mock.calls[0][0];
      expect(connectOpts.hostname).toBe("lower-http");
      expect(connectOpts.port).toBe(4444);
    });
  });

  // -----------------------------------------------------------------------
  // getSystemProxyMac (via proxyFetch fallback)
  // -----------------------------------------------------------------------

  describe("getSystemProxyMac fallback", () => {
    /** Helper: set up proxy tunnel mocks */
    function setupProxyTunnelMocks() {
      const connectReq = makeMockReq();
      const fakeSocket = new EventEmitter();
      mockHttpRequest.mockImplementation(() => {
        queueMicrotask(() => connectReq.emit("connect", {}, fakeSocket));
        return connectReq;
      });

      const httpsReq = makeMockReq();
      const httpsRes = makeMockRes({});
      mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        queueMicrotask(() => {
          cb(httpsRes);
          emitBody(httpsRes);
        });
        return httpsReq;
      });
    }

    /** Helper: set up direct HTTPS mock */
    function setupDirectMocks(body = "direct") {
      const mockReq = makeMockReq();
      const mockRes = makeMockRes({});
      mockHttpsRequest.mockImplementation((_opts: unknown, cb: (res: unknown) => void) => {
        queueMicrotask(() => {
          cb(mockRes);
          emitBody(mockRes, body);
        });
        return mockReq;
      });
    }

    it("uses macOS system proxy when env vars are not set and platform is darwin", async () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const { execSync } = await import("node:child_process");
      const mockExecSync = vi.mocked(execSync);
      mockExecSync.mockReturnValue(
        `<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n}\n`,
      );

      setupProxyTunnelMocks();

      const { proxyFetch } = await loadModule();
      await proxyFetch("https://example.com/");

      // Should connect through the system proxy
      expect(mockHttpRequest).toHaveBeenCalledOnce();
      const connectOpts = mockHttpRequest.mock.calls[0][0];
      expect(connectOpts.hostname).toBe("127.0.0.1");
      expect(connectOpts.port).toBe(7890);
    });

    it("caches the scutil result across calls (within same module load)", async () => {
      // Don't resetModules for this test: we need the cache to persist.
      // We load the module once and call proxyFetch twice.
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const { execSync } = await import("node:child_process");
      const mockExecSync = vi.mocked(execSync);
      mockExecSync.mockReturnValue(
        `<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7890\n  HTTPSProxy : 127.0.0.1\n}\n`,
      );

      setupProxyTunnelMocks();

      const { proxyFetch } = await loadModule();

      // First call triggers scutil
      await proxyFetch("https://example.com/a");

      // Reset call count on execSync to verify second call doesn't invoke it
      mockExecSync.mockClear();

      // Need fresh mocks for the second HTTP cycle
      setupProxyTunnelMocks();

      await proxyFetch("https://example.com/b");

      // execSync should NOT be called again (cached)
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it("falls back to direct when HTTPSEnable is not 1", async () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const { execSync } = await import("node:child_process");
      const mockExecSync = vi.mocked(execSync);
      mockExecSync.mockReturnValue(
        `<dictionary> {\n  HTTPSEnable : 0\n}\n`,
      );

      setupDirectMocks("direct");

      const { proxyFetch } = await loadModule();
      const res = await proxyFetch("https://example.com/");

      // Should NOT go through proxy
      expect(mockHttpRequest).not.toHaveBeenCalled();
      // Should make a direct HTTPS request
      expect(mockHttpsRequest).toHaveBeenCalledOnce();
      const text = await res.text();
      expect(text).toBe("direct");
    });

    it("falls back to direct when platform is not darwin", async () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");

      setupDirectMocks("direct");

      const { proxyFetch } = await loadModule();
      const res = await proxyFetch("https://example.com/");

      expect(mockHttpRequest).not.toHaveBeenCalled();
      expect(mockHttpsRequest).toHaveBeenCalledOnce();
      const text = await res.text();
      expect(text).toBe("direct");
    });

    it("falls back to direct when scutil throws", async () => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

      const { execSync } = await import("node:child_process");
      const mockExecSync = vi.mocked(execSync);
      mockExecSync.mockImplementation(() => {
        throw new Error("scutil not found");
      });

      setupDirectMocks("direct");

      const { proxyFetch } = await loadModule();
      const res = await proxyFetch("https://example.com/");

      expect(mockHttpRequest).not.toHaveBeenCalled();
      const text = await res.text();
      expect(text).toBe("direct");
    });
  });
});
