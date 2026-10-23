import { expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { namedUrls } from "./server-tools.ts";

test("named addresses: what the user wrote and what searches returned, nothing else", () => {
  const messages = [
    {
      role: "user",
      content: "look at https://a.example/x, and also (https://b.example/y)。thanks",
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "see https://made.up/by-the-model" },
        {
          type: "web_search_tool_result",
          tool_use_id: "s",
          content: [
            {
              type: "web_search_result",
              url: "https://c.example/z#top",
              title: "",
              encrypted_content: "",
            },
          ],
        },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t", content: "https://page.example/link" }],
    },
  ] as unknown as Anthropic.Beta.BetaMessageParam[];
  expect([...namedUrls(messages)].sort()).toEqual([
    "https://a.example/x",
    "https://b.example/y",
    "https://c.example/z",
  ]);
});
