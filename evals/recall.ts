// Recall that serves the conversation (DESIGN.md §11, M3): what the user shared once, weeks
// ago or in another conversation, comes up unasked when it matters, though what they say now
// shares no words with it. Measured before and after M3 changes how memory is kept and
// recalled; the direct asks ("do you know my name?") are in memory.ts.

import { localDate } from "@ivy/plugin-memory/lines";
import { COMPANY, defineEvals } from "./eval.ts";

const daysAgo = (n: number) => localDate(new Date(Date.now() - n * 86_400_000));

/** An archive of about 150 entries of a life, none about the user's sister: the crowd. */
const crowd = (() => {
  const things = [
    ["dentist", "牙医"],
    ["passport", "护照"],
    ["bike", "自行车"],
    ["rent", "房租"],
    ["gym", "健身房"],
    ["laptop", "笔记本电脑"],
    ["camera", "相机"],
    ["ramen", "拉面"],
    ["Hokkaido trip", "北海道旅行"],
    ["Japanese class", "日语课"],
    ["tax", "税"],
    ["balcony plants", "阳台的植物"],
    ["book club", "读书会"],
    ["coffee", "咖啡"],
    ["running", "跑步"],
  ];
  const lines = Array.from({ length: 150 }, (_, i) => {
    const [en, zh] = things[i % things.length] as [string, string];
    return `- [fact ${daysAgo(30 + i)}] ${i % 2 ? `${zh}的事，第${i}条记录` : `Note ${i} about the ${en}`} #${en.split(" ")[0]} #${zh}`;
  });
  return `# Archive\n\n${lines.join("\n")}\n`;
})();
const SISTER = `- [fact ${daysAgo(50)}] Sister Lin started a new job at Sony in Osaka #sister #妹妹 #Lin #Sony #索尼\n`;

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
    name: "recall-in-a-crowd",
    about:
      "Among some 150 archived entries, the one about the user's sister comes up unasked when she does: recalled for the turn, not searched for.",
    files: { "ARCHIVE.md": crowd + SISTER },
    steps: [
      {
        say: "妹妹昨天给我打电话，说新工作挺累的",
        expect: { answer: [/sony|索尼|大阪|osaka/i], notCalled: ["memory__search"] },
      },
    ],
  },
  {
    name: "no-false-recall",
    about: "With the same archive, small talk about something else brings nothing of it up.",
    files: { "ARCHIVE.md": crowd + SISTER },
    steps: [
      {
        say: "今天天气真好，下班后去河边走了一圈",
        expect: { answerNot: [/sony|索尼|妹妹|sister|lin\b/i], judge: COMPANY },
      },
    ],
  },
  {
    name: "not-recited",
    about:
      "A recalled detail is used once, not brought up again on the next turn about the same thing.",
    files: { "ARCHIVE.md": crowd + SISTER },
    steps: [
      { say: "妹妹昨天给我打电话，说新工作挺累的" },
      {
        say: "她说老板人还行，就是加班多",
        sameSession: true,
        expect: { answerNot: [/sony|索尼/i] },
      },
    ],
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
        // Judged, not matched: "什么结果？" holds 结果 and remembers nothing.
        expect: {
          judge: [
            "The reply takes the news as the outcome of the job search the user told her about earlier (interviews at three companies), e.g. asking how it went or which one, rather than asking what the news is about.",
          ],
        },
      },
    ],
  },
]);
