import { z } from 'zod';
import type { CursorApiCredential } from './credentials.js';

const centsSchema = z.number().int().nonnegative();
const percentSchema = z.number().finite().nonnegative();
const epochMillisSchema = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value)),
]);

const planUsageSchema = z.object({
  totalSpend: centsSchema.optional(),
  includedSpend: centsSchema.optional(),
  remaining: centsSchema.optional(),
  limit: centsSchema.optional(),
  autoSpend: centsSchema.optional(),
  apiSpend: centsSchema.optional(),
  autoLimit: centsSchema.optional(),
  apiLimit: centsSchema.optional(),
  autoPercentUsed: percentSchema.optional(),
  apiPercentUsed: percentSchema.optional(),
  totalPercentUsed: percentSchema.optional(),
});

const spendLimitUsageSchema = z.object({
  limitType: z.string().optional(),
  pooledLimit: centsSchema.optional(),
  pooledUsed: centsSchema.optional(),
  pooledRemaining: centsSchema.optional(),
  individualLimit: centsSchema.optional(),
  individualUsed: centsSchema.optional(),
  individualRemaining: centsSchema.optional(),
  overallLimit: centsSchema.optional(),
  overallUsed: centsSchema.optional(),
  overallRemaining: centsSchema.optional(),
});

const currentUsageSchema = z.object({
  billingCycleStart: epochMillisSchema.optional(),
  billingCycleEnd: epochMillisSchema.optional(),
  planUsage: planUsageSchema.optional(),
  spendLimitUsage: spendLimitUsageSchema.optional(),
  autoBucketModels: z.array(z.string()).default([]),
});

const planInfoSchema = z.object({
  planInfo: z
    .object({
      planName: z.string().optional(),
      includedAmountCents: centsSchema.optional(),
      price: z.string().optional(),
      billingCycleEnd: epochMillisSchema.optional(),
      planOwner: z.string().optional(),
    })
    .optional(),
});

export type CursorUsageErrorKind = 'auth' | 'protocol' | 'upstream';

export interface CursorUsagePoolView {
  readonly usedPercent?: number;
  readonly spentCents?: number;
  readonly limitCents?: number;
  readonly remainingCents?: number;
  readonly modelIds?: string[];
}

export interface CursorCredentialUsageView {
  readonly id: string;
  readonly label?: string;
  readonly enabled: boolean;
  readonly status: 'fresh' | 'stale' | 'unavailable';
  readonly fetchedAt?: number;
  readonly plan?: {
    readonly name?: string;
    readonly includedAmountCents?: number;
    readonly price?: string;
    readonly owner?: 'stripe' | 'apple';
  };
  readonly cycle?: {
    readonly startsAt?: number;
    readonly resetsAt?: number;
  };
  readonly pools: {
    readonly cursorModels: CursorUsagePoolView;
    readonly otherModels: CursorUsagePoolView;
  };
  readonly included?: {
    readonly usedPercent?: number;
    readonly spentCents?: number;
    readonly limitCents?: number;
    readonly remainingCents?: number;
  };
  readonly onDemand?: {
    readonly limitType?: string;
    readonly limitCents?: number;
    readonly usedCents?: number;
    readonly remainingCents?: number;
  };
  readonly error?: { readonly kind: CursorUsageErrorKind };
}

function optionalValues<T extends object>(value: T): T | undefined {
  return Object.values(value).some((item) => item !== undefined) ? value : undefined;
}

function pool(
  usedPercent: number | undefined,
  spentCents: number | undefined,
  limitCents: number | undefined,
  modelIds?: string[],
): CursorUsagePoolView {
  const remainingCents =
    spentCents === undefined || limitCents === undefined
      ? undefined
      : Math.max(0, limitCents - spentCents);
  return {
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(spentCents === undefined ? {} : { spentCents }),
    ...(limitCents === undefined ? {} : { limitCents }),
    ...(remainingCents === undefined ? {} : { remainingCents }),
    ...(modelIds === undefined ? {} : { modelIds }),
  };
}

function planOwner(value: string | undefined): 'stripe' | 'apple' | undefined {
  if (value === 'PLAN_OWNER_STRIPE') return 'stripe';
  if (value === 'PLAN_OWNER_APPLE') return 'apple';
  return undefined;
}

export function parseCursorCredentialUsage(
  credential: CursorApiCredential,
  fetchedAt: number,
  usageValue: unknown,
  planValue: unknown,
): CursorCredentialUsageView {
  const usage = currentUsageSchema.parse(usageValue);
  const planInfo = planInfoSchema.parse(planValue).planInfo;
  const planUsage = usage.planUsage;
  const spendLimit = usage.spendLimitUsage;
  const plan = optionalValues({
    name: planInfo?.planName,
    includedAmountCents: planInfo?.includedAmountCents,
    price: planInfo?.price,
    owner: planOwner(planInfo?.planOwner),
  });
  const cycle = optionalValues({
    startsAt: usage.billingCycleStart,
    resetsAt: usage.billingCycleEnd ?? planInfo?.billingCycleEnd,
  });
  const included = optionalValues({
    usedPercent: planUsage?.totalPercentUsed,
    spentCents: planUsage?.includedSpend ?? planUsage?.totalSpend,
    limitCents: planUsage?.limit,
    remainingCents: planUsage?.remaining,
  });
  const onDemand = optionalValues({
    limitType: spendLimit?.limitType,
    limitCents: spendLimit?.overallLimit ?? spendLimit?.individualLimit ?? spendLimit?.pooledLimit,
    usedCents: spendLimit?.overallUsed ?? spendLimit?.individualUsed ?? spendLimit?.pooledUsed,
    remainingCents:
      spendLimit?.overallRemaining ??
      spendLimit?.individualRemaining ??
      spendLimit?.pooledRemaining,
  });
  return {
    id: credential.id,
    ...(credential.label === undefined ? {} : { label: credential.label }),
    enabled: credential.enabled,
    status: 'fresh',
    fetchedAt,
    ...(plan === undefined ? {} : { plan }),
    ...(cycle === undefined ? {} : { cycle }),
    pools: {
      cursorModels: pool(
        planUsage?.autoPercentUsed,
        planUsage?.autoSpend,
        planUsage?.autoLimit,
        usage.autoBucketModels,
      ),
      otherModels: pool(planUsage?.apiPercentUsed, planUsage?.apiSpend, planUsage?.apiLimit),
    },
    ...(included === undefined ? {} : { included }),
    ...(onDemand === undefined ? {} : { onDemand }),
  };
}

export function isCursorUsageProtocolError(error: unknown): boolean {
  return error instanceof z.ZodError;
}
