export declare const OPCODES: {
  readonly CONTINUATION: 0x00;
  readonly TEXT: 0x01;
  readonly BINARY: 0x02;
  readonly CLOSE: 0x08;
  readonly PING: 0x09;
  readonly PONG: 0x0a;
};

export declare const CLOSE_CODES: {
  readonly NORMAL_CLOSE: 1000;
  readonly GOING_AWAY: 1001;
  readonly PROTOCOL_ERROR: 1002;
  readonly UNSUPPORTED_DATA: 1003;
  readonly RESERVED: 1004;
  readonly NO_CODE_RECEIVED: 1005;
  readonly CONNECTION_CLOSED_ABNORMALLY: 1006;
  readonly INVALID_PAYLOAD: 1007;
  readonly POLICY_VIOLATED: 1008;
  readonly MESSAGE_TOO_BIG: 1009;
  readonly MANDATORY_EXTENSION: 1010;
  readonly INTERNAL_SERVER_ERROR: 1011;
  readonly TLS_HANDSHAKE: 1015;
};

export declare const DATA_OPCODES: ReadonlySet<number>;
export declare const CONTROL_OPCODES: ReadonlySet<number>;
