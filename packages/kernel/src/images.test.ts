import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimUploads, clearUploads, isImageName, saveUpload } from "./images.ts";
import { PNG } from "./testing.ts";

test("an upload is kept by its content's hash, once, and only as the type it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "ivy-uploads-"));
  const name = saveUpload(dir, PNG, "image/png");
  expect(isImageName(name)).toBe(true);
  expect(name.endsWith(".png")).toBe(true);
  expect(saveUpload(dir, PNG, "image/png")).toBe(name);
  expect(() => saveUpload(dir, PNG, "image/jpeg")).toThrow("isn't a image/jpeg");
  expect(() => saveUpload(dir, PNG, "image/heic")).toThrow("not image/heic");
  expect(() => saveUpload(dir, new Uint8Array(6 * 1024 * 1024), "image/png")).toThrow("5 MB");
});

test("a prompt's uploads move to its session; one never sent is cleared after a day", () => {
  const home = mkdtempSync(join(tmpdir(), "ivy-uploads-"));
  const uploads = join(home, "uploads");
  const images = join(home, "session");
  const name = saveUpload(uploads, PNG, "image/png");
  expect(() => claimUploads(uploads, images, [name, `${"0".repeat(64)}.png`])).toThrow("attach");
  expect(existsSync(join(uploads, name))).toBe(true); // nothing moved
  claimUploads(uploads, images, [name]);
  expect(existsSync(join(images, name))).toBe(true);
  // Sent again in the same session: it is there already.
  claimUploads(uploads, images, [name]);
  expect(() => claimUploads(uploads, images, ["../x.png"])).toThrow();

  const old = saveUpload(uploads, new Uint8Array([...PNG, 9]), "image/png");
  const fresh = saveUpload(uploads, new Uint8Array([...PNG, 8]), "image/png");
  const twoDaysAgo = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  utimesSync(join(uploads, old), twoDaysAgo, twoDaysAgo);
  clearUploads(uploads);
  expect(existsSync(join(uploads, old))).toBe(false);
  expect(existsSync(join(uploads, fresh))).toBe(true);
});
