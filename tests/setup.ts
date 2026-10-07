import { vi } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.MASTER_ENCRYPTION_KEY = '5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b'; // 64 hex char random
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.SOLANA_RPC_URL = 'http://localhost:8899';
process.env.SOLANA_WSS_URL = 'ws://localhost:8900';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
