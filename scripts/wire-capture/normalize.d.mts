export interface NormalizedCaptureRecord {
  schema_version: number;
  lane: string | null;
  conn: number | null;
  stream: number | null;
  dir: string | null;
  frame_index: number | null;
  flags: number | null;
  message_type: string | null;
  headers: Record<string, string> | null;
  payload_sha256: string | null;
  decoded_fields: unknown;
  error?: { kind: string; message: string };
}

export interface NormalizeResult {
  output: string;
  records: NormalizedCaptureRecord[];
  errorCount: number;
}

export declare const SCHEMA_VERSION: number;
export declare function normalizeCapture(input: string): NormalizeResult;
