export const ENVELOPE_VERSION = 2;

export enum MessageKind {
  System = 1,
  App = 2,
}

export enum SystemType {
  Init = 1,
  Ready = 2,
  Error = 3,
  Shutdown = 4,
  Ping = 5,
  Pong = 6,
}

export interface Envelope {
  version: number;
  messageKind: MessageKind;
  systemType: number;
  payload: Uint8Array;
}

export interface SystemEnvelope extends Envelope {
  messageKind: MessageKind.System;
  systemType: SystemType;
}

export interface AppEnvelope extends Envelope {
  messageKind: MessageKind.App;
  systemType: 0;
}
