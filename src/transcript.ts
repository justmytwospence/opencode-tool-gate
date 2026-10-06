// The transcript context Jev judges a call in, read from opencode's session messages
// (`client.session.messages`): the user's recent requests, the agent's latest explanation, and
// the agent's words beside a tool call. Ported from pi-tool-gate's transcript module, which read
// pi's session branch.

/** The part of an opencode message (`{ info, parts }`) this reads. */
export interface MessageLike {
  info: { role: string };
  parts: readonly {
    type: string;
    text?: string;
    synthetic?: boolean;
    tool?: string;
    callID?: string;
    state?: { status?: string; input?: unknown };
  }[];
}

/** The text a user typed, or an assistant wrote: text parts that are not synthetic. */
export function messageText(message: MessageLike): string {
  return message.parts
    .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** The latest user message and the latest assistant text written after it. */
export function recentTexts(messages: readonly MessageLike[]): { user: string; assistant: string } {
  let user = "";
  let assistant = "";
  for (let i = messages.length - 1; i >= 0 && (!user || !assistant); i--) {
    const message = messages[i] as MessageLike;
    const text = messageText(message);
    if (!text) continue;
    if (!user && message.info.role === "user") user = text;
    if (!assistant && !user && message.info.role === "assistant") assistant = text;
  }
  return { user, assistant };
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clipTail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

/** The last `count` user messages, oldest first. */
export function recentUserMessages(messages: readonly MessageLike[], count: number): string[] {
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < count; i--) {
    const message = messages[i] as MessageLike;
    if (message.info.role !== "user") continue;
    const text = messageText(message);
    if (text) out.unshift(text);
  }
  return out;
}

/** Text of the assistant message that issued tool call `callID` (the agent's words beside it). */
export function callerText(messages: readonly MessageLike[], callID: string): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as MessageLike;
    if (message.info.role !== "assistant") continue;
    if (message.parts.some((p) => p.type === "tool" && p.callID === callID)) return messageText(message);
  }
  return "";
}
