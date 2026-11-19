/** Decodes standard base64; throws on malformed input like `atob`. */
export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Terminal payload text, or null when it is not valid base64. */
export function base64ToText(data: string): string | null {
  try {
    return new TextDecoder().decode(base64ToBytes(data));
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
