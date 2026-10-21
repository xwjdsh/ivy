// Images attached to a message go as they are; only one past what the APIs take is shrunk,
// or one of a type they don't take converted (DESIGN.md §5.7). The daemon checks again.

/** The types every API takes, and the most an image may weigh or measure. */
const TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_SIDE = 8000;

/** The image as it can be sent: itself, or shrunk or converted to JPEG. */
export async function sendable(image: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    throw new Error("This image can't be read");
  }
  const { width, height } = bitmap;
  if (
    TYPES.includes(image.type) &&
    image.size <= MAX_BYTES &&
    Math.max(width, height) <= MAX_SIDE
  ) {
    bitmap.close();
    return image;
  }
  let scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  try {
    for (;;) {
      const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("This image can't be read");
      // JPEG has no transparency: what was clear turns white, not black.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      if (out.size <= MAX_BYTES) return out;
      scale *= 0.75;
    }
  } finally {
    bitmap.close();
  }
}
