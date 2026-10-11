import { logger } from './logger';
import { appSettings } from '../config/settings.js';

function withRpcTimeout(init?: RequestInit): RequestInit {
  const timeoutSignal = AbortSignal.timeout(appSettings.RPC_FETCH_TIMEOUT_MS);
  return {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal,
  };
}

export function createFallbackFetch(primaryUrl: string, fallbackUrl?: string) {
  return async (input: string | URL | any, init?: RequestInit): Promise<Response> => {
    let url = input.toString();

    try {
      const response = await fetch(input, withRpcTimeout(init));
      if ((response.status === 429 || response.status === 403 || response.status === 401) && fallbackUrl) {
        logger.warn(`RPC Error (${response.status}) hit on primary, falling back to secondary`);
        // Replace the primary URL with the fallback URL for this request
        return await fetch(fallbackUrl, withRpcTimeout(init));
      }
      return response;
    } catch (err: any) {
      if (fallbackUrl) {
        logger.warn({ err }, 'RPC Network error on primary, falling back to secondary');
        return await fetch(fallbackUrl, withRpcTimeout(init));
      }
      throw err;
    }
  };
}
