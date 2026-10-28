// Optional AI writer (Claude or Grok). It only explains numbers the bot already recorded.
// It never picks bets, sizes bets or changes settings. Off unless an API key secret is set.

export interface AiConfig {
  provider: "anthropic" | "xai";
  key: string;
  model: string;
}

export const DEFAULT_MODELS = { anthropic: "claude-haiku-5-5", xai: "grok-4.3" } as const;

/**
 * Picks the provider from secrets: ANTHROPIC_API_KEY (Claude) or XAI_API_KEY (Grok).
 * AI_PROVIDER = "anthropic" | "xai" chooses when both are set; AI_MODEL overrides the model.
 */
export function aiFromEnv(get: (name: string) => string | undefined): AiConfig | null {
  const pref = (get("AI_PROVIDER") ?? "").trim().toLowerCase();
  const anthropic = get("ANTHROPIC_API_KEY")?.trim();
  const xai = get("XAI_API_KEY")?.trim();
  const model = get("AI_MODEL")?.trim();
  const make = (provider: AiConfig["provider"], key: string): AiConfig => ({ provider, key, model: model || DEFAULT_MODELS[provider] });
  if ((pref === "xai" || pref === "grok") && xai) return make("xai", xai);
  if ((pref === "anthropic" || pref === "claude") && anthropic) return make("anthropic", anthropic);
  if (anthropic) return make("anthropic", anthropic);
  if (xai) return make("xai", xai);
  return null;
}

export const REPORT_SYSTEM = [
  "You write a short weekly update for the owner of a sports prediction-market bot. The owner is a beginner.",
  "Use only the numbers in the data you are given. Never invent results, games or numbers.",
  "Paper bets use fake money: always call them a simulation. Keep paper and real money separate.",
  "Never predict future results, never promise or imply profit, never suggest bigger bets or changing the rules.",
  "If fewer than 100 bets have settled, say plainly that results so far are mostly luck.",
  "If 'beat the close' is given, explain it as the best early sign of a real edge (positive is good, near zero means no edge yet).",
  "If nothing has been bet yet, say why from the data (for example a missing odds key) in one sentence.",
  "Write 4 to 6 short sentences in plain words. No headings, no lists, no markdown.",
].join(" ");

const MAX_CHARS = 1500;

/** One request to the chosen model. Throws on any failure so the caller can fall back. */
export async function explain(cfg: AiConfig, system: string, data: unknown, fetchImpl: typeof fetch = fetch): Promise<string> {
  const user = "Here is this week's data as JSON. Write the update.\n\n" + JSON.stringify(data);
  let text = "";
  if (cfg.provider === "anthropic") {
    const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: cfg.model, max_tokens: 500, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    text = (body.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  } else {
    const res = await fetchImpl("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 500,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Grok API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = await res.json();
    text = body.choices?.[0]?.message?.content ?? "";
  }
  text = String(text).trim();
  if (!text) throw new Error("AI returned no text");
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS).replace(/\s+\S*$/, "") + "…" : text;
}
