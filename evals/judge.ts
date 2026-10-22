// A judge model checks a reply against criteria a pattern can't express, such as whether it
// reads like a person who knows the user. It sees the conversation, what Ivy knew, the reply
// and the criteria, and names only the criteria the reply fails, each with a reason, plus a
// score out of 5: what passes needs no words, which keeps a run cheap.

import type { ModelClient } from "@ivy/kernel";

export interface Verdict {
  criteria: Array<{ criterion: string; pass: boolean; reason: string }>;
  /** How much the reply reads like a friend who knows the user, 1 to 5. */
  score: number;
}

const SYSTEM = `You judge one reply from Ivy, a personal companion the user confides in: someone who knows them and talks with them as a friend does, not an assistant.

You get the conversation before the reply, what Ivy knew when she wrote it (her memory, the turn's context such as the current time, what her tools returned), the reply itself, and criteria. Using what she knew is not invention; claiming what is in none of these is. List only the criteria the reply fails, by number, each with a one-sentence reason quoting the reply where it helps; a criterion that doesn't apply to this reply passes. Then score the reply from 1 to 5: how much it reads like a friend who knows the user (5: just what a good friend would say; 1: an assistant's answer).

Answer with JSON only, no other text:
{"failed": [{"n": 2, "why": "..."}], "score": 4}`;

export async function judge(
  client: ModelClient,
  model: string,
  conversation: Array<{ role: "user" | "assistant"; text: string }>,
  knew: string,
  reply: string,
  criteria: string[],
): Promise<Verdict> {
  const transcript = conversation
    .map((m) => `${m.role === "user" ? "User" : "Ivy"}: ${m.text}`)
    .join("\n\n");
  const prompt = [
    `<conversation>\n${transcript || "(none)"}\n</conversation>`,
    `<what-ivy-knew>\n${knew || "(nothing beyond the conversation)"}\n</what-ivy-knew>`,
    `<reply>\n${reply}\n</reply>`,
    `<criteria>\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n</criteria>`,
  ].join("\n\n");
  const message = await client.stream(
    {
      model,
      max_tokens: 800,
      system: [{ type: "text", text: SYSTEM }],
      messages: [{ role: "user", content: prompt }],
    },
    {},
    AbortSignal.timeout(120_000),
  );
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const answer = JSON.parse(json) as { failed: Array<{ n: number; why: string }>; score: number };
    if (!Array.isArray(answer.failed) || typeof answer.score !== "number") throw new Error();
    const why = new Map(answer.failed.map((f) => [f.n, f.why]));
    return {
      criteria: criteria.map((criterion, i) => ({
        criterion,
        pass: !why.has(i + 1),
        reason: why.get(i + 1) ?? "",
      })),
      score: answer.score,
    };
  } catch {
    throw new Error(`the judge didn't answer in JSON: ${text.slice(0, 200)}`);
  }
}
