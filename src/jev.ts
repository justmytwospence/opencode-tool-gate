// Jev, TypeSafe's System One model, over its HTTP API (https://docs.typesafe.ai/api.md).
// Needs TYPESAFE_API_KEY. Never throws: every failure is `{ ok: false, reason }`.

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: readonly string[] };

export type Answer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number };

export interface JevOptions {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export type JevOutcome =
  | { ok: true; answers: Record<string, Answer>; model: string; latencyMs: number; inputTokens?: number }
  | { ok: false; reason: string };

export async function askJev(
  state: unknown,
  questions: Record<string, Question>,
  options: JevOptions = {},
): Promise<JevOutcome> {
  const apiKey = (options.apiKey ?? process.env.TYPESAFE_API_KEY)?.trim();
  if (!apiKey) return { ok: false, reason: "TYPESAFE_API_KEY is not set" };
  const started = Date.now();
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 1_500);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: options.model ?? "jev-latest", state, questions }),
      signal,
    });
  } catch (error) {
    if (timeout.aborted) return { ok: false, reason: "timed out" };
    if (options.signal?.aborted) return { ok: false, reason: "cancelled" };
    return { ok: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 160) };
  }
  if (!response.ok) {
    return { ok: false, reason: response.status === 401 ? "invalid API key" : `HTTP ${response.status}` };
  }
  let body: { model?: string; answers?: Record<string, Answer>; usage?: { input_tokens?: number } };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, reason: "unreadable response" };
  }
  if (!body.answers) return { ok: false, reason: "response without answers" };
  return {
    ok: true,
    answers: body.answers,
    model: body.model ?? "",
    latencyMs: Date.now() - started,
    ...(typeof body.usage?.input_tokens === "number" ? { inputTokens: body.usage.input_tokens } : {}),
  };
}

export function noul(answers: Record<string, Answer>, id: string): number | undefined {
  const a = answers[id];
  return a?.type === "noul" && Number.isFinite(a.noul) ? a.noul : undefined;
}

export function score(answers: Record<string, Answer>, id: string): { score: number; confidence: number } | undefined {
  const a = answers[id];
  return a?.type === "score" && Number.isFinite(a.score) ? { score: a.score, confidence: a.confidence } : undefined;
}

export function choice(answers: Record<string, Answer>, id: string) {
  const a = answers[id];
  return a?.type === "choice" ? a : undefined;
}
