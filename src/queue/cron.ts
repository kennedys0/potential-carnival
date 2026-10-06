import { getRedisConnection } from './connection';
import { QUEUE_NAMES, MonitorJobPayload } from './queues';
import { Queue } from 'bullmq';
import { TradeRepository } from '../database/repositories/tradeRepository';

export async function schedulePositionMonitoring(tradeRepo: TradeRepository) {
  const redis = getRedisConnection();
  const monitorQueue = new Queue<MonitorJobPayload>(QUEUE_NAMES.MONITOR, { connection: redis });

  // Add a repeatable job that runs every minute to fetch open positions and queue them
  await monitorQueue.add(
    'schedule-monitor',
    {} as any, // Not a specific position, this is the orchestrator job
    {
      repeat: {
        pattern: '* * * * *', // every minute
      }
    }
  );

  // But we need a separate worker to process 'schedule-monitor' or just a simple setInterval in node.
  // Actually, BullMQ repeatable jobs need a worker to process them.
  // We can just use `setInterval` inside `index.ts` instead to avoid nested workers for simplicity.
}
