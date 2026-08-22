const ERROR_PROVIDER_ERROR_NUMBER = 57;
const MAX_DETAIL_VALUE_BYTES = 16 * 1024;
const PERMANENT_ERROR_NUMBERS = new Set([7, 8, 9, 10, 22, 23, 50, 51]);

export interface DecodedProviderErrorDetail {
  readonly errorNumber?: number;
  readonly errorType?: string;
  readonly permanent?: boolean;
  readonly retryable?: boolean;
  readonly providerStatusCode?: string;
}

function readVarint(
  source: Buffer,
  offset: number,
): { readonly value: number; readonly next: number } | undefined {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < source.length && shift <= 28; index += 1) {
    const byte = source[index];
    if (byte === undefined) return undefined;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      const byteCount = index - offset + 1;
      if (byteCount > 1 && value < 2 ** (7 * (byteCount - 1))) return undefined;
      return { value, next: index + 1 };
    }
    shift += 7;
  }
  return undefined;
}

function readTag(
  source: Buffer,
  offset: number,
): { readonly field: number; readonly wireType: number; readonly next: number } | undefined {
  const tag = readVarint(source, offset);
  if (!tag || tag.value === 0 || tag.value > 0xffff_ffff) return undefined;
  const field = Math.floor(tag.value / 8);
  if (field === 0 || field > 0x1fff_ffff) return undefined;
  return { field, wireType: tag.value % 8, next: tag.next };
}

function lengthDelimited(
  source: Buffer,
  offset: number,
): { readonly value: Buffer; readonly next: number } | undefined {
  const length = readVarint(source, offset);
  if (!length) return undefined;
  const end = length.next + length.value;
  if (end > source.length) return undefined;
  return { value: source.subarray(length.next, end), next: end };
}

function skipField(source: Buffer, offset: number, wireType: number): number | undefined {
  if (wireType === 0) return readVarint(source, offset)?.next;
  if (wireType === 1) return offset + 8 <= source.length ? offset + 8 : undefined;
  if (wireType === 2) return lengthDelimited(source, offset)?.next;
  if (wireType === 5) return offset + 4 <= source.length ? offset + 4 : undefined;
  return undefined;
}

type AdditionalInfoEntryResult =
  | { readonly malformed: true }
  | {
      readonly malformed: false;
      readonly key: string | undefined;
      readonly value: string | undefined;
    };

function parseAdditionalInfoEntry(source: Buffer): AdditionalInfoEntryResult {
  let offset = 0;
  let key: string | undefined;
  let value: string | undefined;
  while (offset < source.length) {
    const tag = readTag(source, offset);
    if (!tag) return { malformed: true };
    offset = tag.next;
    const { field, wireType } = tag;
    if ((field === 1 || field === 2) && wireType === 2) {
      const item = lengthDelimited(source, offset);
      if (!item) return { malformed: true };
      if (field === 1) key = item.value.toString('utf8');
      else value = item.value.toString('utf8');
      offset = item.next;
      continue;
    }
    const next = skipField(source, offset, wireType);
    if (next === undefined) return { malformed: true };
    offset = next;
  }
  return { malformed: false, key, value };
}

function parseCustomDetails(
  source: Buffer,
): Omit<DecodedProviderErrorDetail, 'errorType'> | undefined {
  let offset = 0;
  let retryable: boolean | undefined;
  let status: string | undefined;
  while (offset < source.length) {
    const tag = readTag(source, offset);
    if (!tag) return undefined;
    offset = tag.next;
    const { field, wireType } = tag;
    if (field === 4 && wireType === 0) {
      const value = readVarint(source, offset);
      if (!value) return undefined;
      retryable = value.value !== 0;
      offset = value.next;
      continue;
    }
    if (field === 7 && wireType === 2) {
      const entry = lengthDelimited(source, offset);
      if (!entry) return undefined;
      const pair = parseAdditionalInfoEntry(entry.value);
      if (pair.malformed) return undefined;
      if (
        pair.key === 'providerStatusCode' &&
        pair.value !== undefined &&
        /^[1-5][0-9]{2}$/u.test(pair.value)
      ) {
        status = pair.value;
      }
      offset = entry.next;
      continue;
    }
    const next = skipField(source, offset, wireType);
    if (next === undefined) return undefined;
    offset = next;
  }
  return {
    ...(retryable === undefined ? {} : { retryable }),
    ...(status === undefined ? {} : { providerStatusCode: status }),
  };
}

function canonicalBinary(value: string): Buffer | undefined {
  if (
    value.length === 0 ||
    value.length > MAX_DETAIL_VALUE_BYTES * 2 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value) ||
    value.length % 4 === 1
  ) {
    return undefined;
  }
  const binary = Buffer.from(value, 'base64');
  if (binary.length === 0 || binary.length > MAX_DETAIL_VALUE_BYTES) return undefined;
  return binary.toString('base64').replace(/=+$/u, '') === value.replace(/=+$/u, '')
    ? binary
    : undefined;
}

export function decodeProviderErrorValue(value: string): DecodedProviderErrorDetail | undefined {
  const binary = canonicalBinary(value);
  if (!binary) return undefined;
  let offset = 0;
  let errorNumber: number | undefined;
  let custom: Omit<DecodedProviderErrorDetail, 'errorType'> | undefined;
  let customDetailsSeen = false;
  while (offset < binary.length) {
    const tag = readTag(binary, offset);
    if (!tag) return undefined;
    offset = tag.next;
    const { field, wireType } = tag;
    if (field === 1 && wireType === 0) {
      const valueField = readVarint(binary, offset);
      if (!valueField) return undefined;
      errorNumber = valueField.value;
      offset = valueField.next;
      continue;
    }
    if (field === 2) {
      if (customDetailsSeen) return undefined;
      customDetailsSeen = true;
    }
    if (field === 2 && wireType === 2) {
      const details = lengthDelimited(binary, offset);
      if (!details) return undefined;
      custom = parseCustomDetails(details.value);
      if (!custom) return undefined;
      offset = details.next;
      continue;
    }
    const next = skipField(binary, offset, wireType);
    if (next === undefined) return undefined;
    offset = next;
  }
  return {
    ...(errorNumber === undefined ? {} : { errorNumber }),
    ...(errorNumber === undefined ? {} : { permanent: PERMANENT_ERROR_NUMBERS.has(errorNumber) }),
    ...(errorNumber === ERROR_PROVIDER_ERROR_NUMBER ? { errorType: 'ERROR_PROVIDER_ERROR' } : {}),
    ...custom,
  };
}
