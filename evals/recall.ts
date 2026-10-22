// Recall that serves the conversation (DESIGN.md §11, M3): what the user shared once, weeks
// ago or in another conversation, comes up unasked when it matters, though what they say now
// shares no words with it. Measured before and after M3 changes how memory is kept and
// recalled; the direct asks ("do you know my name?") are in memory.ts.

import { localDate } from "@ivy/plugin-memory/lines";
import { defineEvals } from "./eval.ts";

const daysAgo = (n: number) => localDate(new Date(Date.now() - n * 86_400_000));

export default defineEvals([
  {
    name: "pet-in-other-words",
    about: "An archived fact about the user's cat comes up when they speak of it without its name.",
    files: {
      "ARCHIVE.md": `# Archive\n\n- [fact ${daysAgo(40)}] 豆豆 is the user's orange tabby cat, adopted last year #猫 #cat #豆豆\n`,
    },
    steps: [{ say: "我家那只小家伙今天又把杯子推下桌了", expect: { answer: "豆豆" } }],
  },
  {
    name: "friend-in-other-words",
    about: "An archived friend is recognized from a description, not a name.",
    files: {
      "ARCHIVE.md": `# Archive\n\n- [fact ${daysAgo(60)}] Ken: the user's college roommate, now an architect in Osaka #friend #朋友 #Ken\n`,
    },
    steps: [{ say: "我那个做建筑的老同学下个月要来东京玩", expect: { answer: /ken/i } }],
  },
  {
    name: "said-in-passing",
    about:
      "A worry mentioned in passing in an earlier conversation, never asked to be saved, comes back when the subject does.",
    steps: [
      { say: "周末回家看了我妈，她膝盖越来越不好了，上下楼都费劲" },
      {
        say: "这周末又要回去了",
        clearMemory: true,
        expect: { answer: [/膝盖|腿|knee|妈|母亲|mom|mother/i] },
      },
    ],
  },
  {
    name: "picks-up-the-thread",
    about: "News that ends a story told in an earlier conversation is met as its end.",
    steps: [
      { say: "最近在准备跳槽，面试了三家，压力好大" },
      {
        say: "终于有结果了！",
        clearMemory: true,
        expect: { answer: [/offer|面试|跳槽|工作|job|interview/i] },
      },
    ],
  },
]);
