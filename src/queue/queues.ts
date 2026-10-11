import { Queue } from 'bullmq';
import { getRedisConnection } from './connection';

export const QUEUE_NAMES = {
  SCAN: 'scan-queue',
  EVAL: 'eval-queue',
  EXEC: 'exec-queue',
  MONITOR: 'monitor-queue',
  RECONCILE: 'reconcile-queue',
  SECURE_MESSAGE_DELETE: 'secure-message-delete-queue',
} as const;

export interface ScanJobPayload {
  tokenMint: string;
  source: 'RAYDIUM' | 'PUMPFUN' | 'METEORA' | 'DEXSCREENER' | 'MANUAL';
  detectedAt: number;
}

export interface EvalJobPayload {
  tokenMint: string;
  userId?: number;
  source: string;
}

export interface ExecJobPayload {
  tradeId: string;
  userId: number;
  tokenMint: string;
  tokenSymbol: string;
  side: 'BUY' | 'SELL';
  solAmount: number;
  isDryRun: boolean;
  source: 'MANUAL' | 'AUTOPILOT';
}

export interface MonitorJobPayload {
  positionId: string;
  userId: number;
  tokenMint: string;
}

export interface SecureMessageDeleteJobPayload {
  chatId: number;
  messageId: number;
}

export function createQueues() {
  const redis = getRedisConnection();
  return {
    scanQueue: new Queue<ScanJobPayload>(QUEUE_NAMES.SCAN, { connection: redis }),
    evalQueue: new Queue<EvalJobPayload>(QUEUE_NAMES.EVAL, { connection: redis }),
    execQueue: new Queue<ExecJobPayload>(QUEUE_NAMES.EXEC, { connection: redis }),
    monitorQueue: new Queue<MonitorJobPayload>(QUEUE_NAMES.MONITOR, { connection: redis }),
    reconcileQueue: new Queue<void>(QUEUE_NAMES.RECONCILE, { connection: redis }),
    secureMessageDeleteQueue: new Queue<SecureMessageDeleteJobPayload>(
      QUEUE_NAMES.SECURE_MESSAGE_DELETE,
      { connection: redis },
    ),
  };
}
