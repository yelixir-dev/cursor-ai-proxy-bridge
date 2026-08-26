import {
  ConnectFrameDecoder,
  encodeConnectFrame,
} from '../../src/backend/cursor-api/connect-frame.js';
import { loadProtoDescriptors, ProtoCodec } from '../../src/backend/cursor-api/protobuf.js';

const codec = new ProtoCodec(loadProtoDescriptors());

export function builtinArgsFrame(
  caseName: string,
  value: Record<string, unknown>,
  id = 1,
  execId = typeof value.execId === 'string' ? value.execId : 'exec',
): Buffer {
  return encodeConnectFrame(
    codec.encode('agent.v1.AgentServerMessage', {
      message: {
        case: 'execServerMessage',
        value: {
          id,
          execId,
          message: { case: caseName, value },
        },
      },
    }),
  );
}

export function clientMessageCases(writes: readonly Buffer[]): string[] {
  const decoder = new ConnectFrameDecoder();
  return writes.flatMap((write) =>
    decoder.push(write).flatMap((frame) => {
      try {
        if (!frame.payload) return [];
        const decoded = codec.decode('agent.v1.ExecClientMessage', frame.payload);
        const message = decoded.message;
        return typeof message === 'object' &&
          message !== null &&
          'case' in message &&
          typeof message.case === 'string'
          ? [message.case]
          : [];
      } catch {
        return [];
      }
    }),
  );
}
