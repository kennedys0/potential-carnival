import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSecureMessageDeleteWorker } from '../../src/queue/workers/secureMessageDeleteWorker';

vi.mock('../../src/utils/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../src/queue/connection', () => ({
  getRedisConnection: vi.fn(() => ({})),
}));

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name, processor, options) => ({
    name,
    processor,
    options,
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

describe('secure message deletion worker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes the exact queued Telegram message', async () => {
    const botApi = { deleteMessage: vi.fn().mockResolvedValue(true) };
    const worker: any = createSecureMessageDeleteWorker(botApi);

    await worker.processor({ data: { chatId: 123, messageId: 456 } });

    expect(botApi.deleteMessage).toHaveBeenCalledWith(123, 456);
  });

  it('treats an already-deleted message as completed', async () => {
    const botApi = {
      deleteMessage: vi.fn().mockRejectedValue(new Error('Bad Request: message to delete not found')),
    };
    const worker: any = createSecureMessageDeleteWorker(botApi);

    await expect(worker.processor({ data: { chatId: 123, messageId: 456 } }))
      .resolves.toBeUndefined();
  });
});
