// JSON types
export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

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

// Generic payload codec interface implementation for JSON
export function encodePayload<T>(data: T): Uint8Array {
  return encoder.encode(JSON.stringify(data));
}

export function decodePayload<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes)) as T;
}
