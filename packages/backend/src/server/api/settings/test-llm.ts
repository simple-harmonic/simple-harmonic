import { getCodexAccessToken, getCodexAuthStatus } from "../../codex-auth";
import { getApiKeySource, getConfig } from "../../config";
import { proxyFetch } from "../../proxy-fetch";
import OpenAI from "openai";

// Undici hides the real network failure in err.cause. Walk the chain so we
// surface "ECONNREFUSED", "EAI_AGAIN", "ETIMEDOUT", etc. instead of the
// useless top-level "fetch failed".
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown error";
  const parts = [err.message];
  let cause = (err as { cause?: unknown }).cause;
  let depth = 0;
  while (cause && depth < 4) {
    if (cause instanceof Error) {
      parts.push(cause.message);
      cause = (cause as { cause?: unknown }).cause;
    } else if (typeof cause === "object" && cause !== null) {
      const obj = cause as { code?: string; message?: string };
      if (obj.code) parts.push(`code=${obj.code}`);
      if (obj.message) parts.push(obj.message);
      break;
    } else {
      break;
    }
    depth++;
  }
  // Dedupe consecutive identical fragments
  const out: string[] = [];
  for (const p of parts) {
    if (out[out.length - 1] !== p) out.push(p);
  }
  return out.join(" · ");
}

export async function POST() {
  const { openaiApiKey, openaiBaseUrl, model } = getConfig();
  const source = getApiKeySource();

  if (!openaiApiKey && source !== "codex") {
    return Response.json({
      ok: false,
      error: "No API key configured. Add an OpenAI key or sign in with Codex.",
    });
  }

  if (source === "codex") {
    return testCodex(model);
  }

  return testOpenai(openaiApiKey, openaiBaseUrl, model);
}

async function testOpenai(apiKey: string, baseUrl: string, model: string) {
  try {
    const client = new OpenAI({ apiKey, baseURL: baseUrl, timeout: 10000 });
    const res = await client.chat.completions.create({
      model,
      max_tokens: 10,
      messages: [{ role: "user", content: "Reply with the word OK." }],
    });
    const text = res.choices[0]?.message?.content ?? "";
    return Response.json({ ok: true, model, response: text.slice(0, 50) });
  } catch (err) {
    console.error("[test-llm openai]", err);
    return Response.json({ ok: false, error: describeError(err) });
  }
}

async function testCodex(model: string) {
  const token = getCodexAccessToken();
  if (!token) {
    return Response.json({
      ok: false,
      error: "No Codex access token. Sign in (or re-authenticate) above.",
    });
  }

  const status = getCodexAuthStatus();
  const accountId = status.accountId || "";

  if (!accountId) {
    return Response.json({
      ok: false,
      error: "Codex auth file is present but has no account_id. Re-authenticate.",
    });
  }

  try {
    const res = await proxyFetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "ChatGPT-Account-ID": accountId,
        "User-Agent": "codex_cli_rs/0.0.0",
        originator: "codex_cli_rs",
      },
      body: JSON.stringify({
        model,
        instructions: "You are a helpful assistant.",
        input: [{ role: "user", content: "Reply with the word OK." }],
        store: false,
        stream: true,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return Response.json({
        ok: false,
        error: `Codex API ${res.status}: ${text.slice(0, 200)}`,
      });
    }

    const raw = await res.text();

    let outputText = "";
    for (const line of raw.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.type === "response.output_text.done") {
          outputText = data.text || "";
        }
      } catch {}
    }

    const modelMatch = raw.match(/"model":"([^"]+)"/);
    const actualModel = modelMatch?.[1] || model;

    return Response.json({
      ok: true,
      model: actualModel,
      response: outputText.slice(0, 50) || "OK",
    });
  } catch (err) {
    console.error("[test-llm codex]", err);
    return Response.json({ ok: false, error: describeError(err) });
  }
}
