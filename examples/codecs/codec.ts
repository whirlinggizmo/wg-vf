// Generic payload codec interface
// Implementations can use JSON, MessagePack, Protobuf, etc.

export interface PayloadCodec {
  encodePayload<T>(data: T): Uint8Array;
  decodePayload<T>(bytes: Uint8Array): T;
}
