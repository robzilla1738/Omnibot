export const GAUNTLET_AVATAR = "/omnibot-gauntlet.png";
export const MAX_AVATAR_LENGTH = 800_000;

export function avatarSource(value?: string | null): string | undefined {
  if (value === GAUNTLET_AVATAR || value === "/botfinity-gauntlet.png") return GAUNTLET_AVATAR;
  if (value && value.length <= MAX_AVATAR_LENGTH && /^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(value)) return value;
  return undefined;
}

/** Decode and resize locally; no uploads, external URLs, or provider calls. */
export async function readAvatar(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  if (file.size > 10 * 1024 * 1024) throw new Error("Choose an image smaller than 10 MB.");
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => { throw new Error("This image could not be opened. Try another file."); });
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth * img.naturalHeight > 40_000_000) {
      throw new Error("Choose an image smaller than 40 megapixels.");
    }
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 384 / Math.max(img.naturalWidth, img.naturalHeight));
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image processing is unavailable. Try again.");
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const result = canvas.toDataURL("image/png");
    if (!avatarSource(result)) throw new Error("This image is too large to save. Choose a smaller image.");
    return result;
  } finally { URL.revokeObjectURL(url); }
}
