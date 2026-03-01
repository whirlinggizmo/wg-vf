import type { JsonValue } from "./types";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function decodeJsonPayload(payload: Uint8Array): JsonValue {
  try {
    return JSON.parse(decoder.decode(payload)) as JsonValue;
  } catch (cause) {
    throw new Error("Failed to decode JSON payload", { cause });
  }
}

export function encodeJsonPayload(json: JsonValue): Uint8Array {
  try {
    return encoder.encode(JSON.stringify(json));
  } catch (cause) {
    throw new Error("Failed to encode JSON payload", { cause });
  }
}
