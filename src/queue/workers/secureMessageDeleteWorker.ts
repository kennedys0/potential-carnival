import { Job, Worker } from 'bullmq';
import { getRedisConnection } from '../connection';
import { QUEUE_NAMES, SecureMessageDeleteJobPayload } from '../queues';
import { logger } from '../../utils/logger';

export function createSecureMessageDeleteWorker(botApi: {
  deleteMessage(chatId: number, messageId: number): Promise<unknown>;
}) {
  const worker = new Worker<SecureMessageDeleteJobPayload>(
    QUEUE_NAMES.SECURE_MESSAGE_DELETE,
    async (job: Job<SecureMessageDeleteJobPayload>) => {
      const { chatId, messageId } = job.data;
      try {
        await botApi.deleteMessage(chatId, messageId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/message to delete not found|message identifier is not specified/i.test(message)) {
          return;
        }
        logger.error({ err: error, chatId, messageId }, 'Failed to delete secure Telegram message');
        throw error;
      }
    },
    { connection: getRedisConnection() },
  );

  worker.on('failed', (job, error) => {
    logger.error({ err: error, jobId: job?.id }, 'Secure message deletion job failed');
  });
  return worker;
}
