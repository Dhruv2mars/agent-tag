// Image type from magic bytes. T3 accepts only these four image types, and the type sent to T3 comes
// from the bytes, never from Slack's declared mimetype.

export type SniffedImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function startsWith(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + prefix.length) return false;
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** The image type the bytes start with, or null when they are not PNG, JPEG, GIF or WebP. */
export function sniffImageMime(bytes: Uint8Array): SniffedImageMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return "image/gif";
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return "image/webp";
  return null;
}
