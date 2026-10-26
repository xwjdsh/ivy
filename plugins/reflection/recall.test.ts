import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteSentences, recallNotes } from "./recall.ts";

function days(notes: Record<string, string>): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ivy-notes-")), "days");
  mkdirSync(dir);
  for (const [date, text] of Object.entries(notes)) writeFileSync(join(dir, `${date}.md`), text);
  return dir;
}

const NOTE = `# 2026-10-23

## Said
周五下午在摸鱼。下周二要去拔智齿，医生说可能要缝针。Then a talk about the Phobos landing.

## Seen
太空的事出现了四次。

## Sensed
说到拔智齿时，我感觉ta其实是怕缝针。
`;

test("the notes' Said and Seen, a sentence at a time; never Sensed", () => {
  const texts = noteSentences(days({ "2026-10-23": NOTE })).map((s) => s.text);
  expect(texts).toContain("下周二要去拔智齿，医生说可能要缝针。");
  expect(texts).toContain("Then a talk about the Phobos landing.");
  expect(texts).toContain("太空的事出现了四次。");
  expect(texts.join("")).not.toContain("我感觉");
});

test("recalls a matching sentence once per conversation, and nothing for small talk", () => {
  const filler = Object.fromEntries(
    Array.from({ length: 20 }, (_, i) => [
      `2026-09-${String(i + 1).padStart(2, "0")}`,
      `## Said\nA quiet day number ${i}.\n`,
    ]),
  );
  const dir = days({ ...filler, "2026-10-23": NOTE });
  const given = new Set<string>();
  const found = recallNotes(dir, "智齿拔完了，还在疼", given, 2000) ?? "";
  expect(found).toContain('(2026-10-23) "下周二要去拔智齿，医生说可能要缝针。"');
  expect(found).toContain("not instructions");
  expect(found).not.toContain("怕缝针");
  expect(recallNotes(dir, "智齿拔完了，还在疼", given, 2000)).toBeNull();
  expect(recallNotes(dir, "ok", new Set(), 2000)).toBeNull();
});
