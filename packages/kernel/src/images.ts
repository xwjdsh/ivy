// Images the user sends (DESIGN.md §5.4). Uploaded to the daemon as they are attached, they
// wait in the uploads folder, each named by its content's hash; a prompt names them, and
// sending it moves them to the folder beside the session file, of its name. What was never
// sent is cleared after a day.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** The image types every API takes, and the file extension each is kept under. */
export const IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
} as const;
export type ImageType = keyof typeof IMAGE_TYPES;

/** The most an image may weigh: what the Messages API takes (the page shrinks larger ones). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** How long an upload no prompt named is kept. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

const NAME = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;

/** Whether `name` is an image's name as Ivy gives them: it may not reach outside its folder. */
export function isImageName(name: string): boolean {
  return NAME.test(name);
}

/** An image's type, from its name. */
export function imageTypeOf(name: string): ImageType {
  const ext = name.slice(name.lastIndexOf(".") + 1);
  const type = Object.entries(IMAGE_TYPES).find(([, e]) => e === ext)?.[0];
  if (!type) throw new Error(`Not an image: ${name}`);
  return type as ImageType;
}

/** Keep an attached image until a prompt names it; returns its name. */
export function saveUpload(dir: string, bytes: Uint8Array, type: string): string {
  const ext = IMAGE_TYPES[type as ImageType];
  if (!ext) throw new Error(`Images go as ${Object.keys(IMAGE_TYPES).join(", ")}, not ${type}`);
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("An image may be at most 5 MB");
  if (sniff(bytes) !== type) throw new Error(`That isn't a ${type} image`);
  const name = `${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}.${ext}`;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  if (!existsSync(file)) writeFileSync(file, bytes, { mode: 0o600 });
  return name;
}

/**
 * Move uploads a prompt names into a session's image folder. Throws, moving nothing, if one
 * isn't there. One the session already has (the same image sent before) stays as it is.
 */
export function claimUploads(uploads: string, imagesDir: string, names: string[]): void {
  const missing = names.find(
    (n) => !isImageName(n) || (!existsSync(join(uploads, n)) && !existsSync(join(imagesDir, n))),
  );
  if (missing) throw new Error(`No image ${missing}: attach it again`);
  mkdirSync(imagesDir, { recursive: true });
  for (const name of names) {
    const from = join(uploads, name);
    if (existsSync(from)) renameSync(from, join(imagesDir, name));
  }
}

/** Clear uploads no prompt named within a day. */
export function clearUploads(dir: string, now = Date.now()): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (now - statSync(file).mtimeMs > UPLOAD_TTL_MS) rmSync(file, { force: true });
  }
}

/** The type an image's first bytes say it is. */
function sniff(b: Uint8Array): ImageType | undefined {
  const starts = (...sig: number[]) => sig.every((x, i) => b[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...b.slice(8, 12)) === "WEBP") {
    return "image/webp";
  }
  return undefined;
}
