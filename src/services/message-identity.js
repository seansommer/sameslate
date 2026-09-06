import { normalizeNickname } from "../core.js";

// 32 symbols avoid confusing O/0 and I/1 pairs; 16 symbols carry 80 random bits.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createMessageId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => ALPHABET[byte & 31]).join("");
}

export function normalizeMessageId(value) {
  return String(value || "").replace(/[\s-]/g, "").toUpperCase();
}

export async function messageLookupKey(messageId, nickname) {
  const id = normalizeMessageId(messageId);
  if (!/^[A-Z0-9]{16}$/.test(id)) throw new Error("Enter the player's 16-character Message ID.");
  const name = normalizeNickname(nickname);
  if (!name) throw new Error("Enter the player's nickname too.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`message-v1|${id}|${name}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
