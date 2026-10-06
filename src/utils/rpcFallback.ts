import { logger } from './logger';

export function createFallbackFetch(primaryUrl: string, fallbackUrl?: string) {
  return async (input: string | URL | any, init?: RequestInit): Promise<Response> => {
    let url = input.toString();

    try {
      const response = await fetch(input, init);
      if ((response.status === 429 || response.status === 403 || response.status === 401) && fallbackUrl) {
        logger.warn(`RPC Error (${response.status}) hit on primary, falling back to secondary`);
        // Replace the primary URL with the fallback URL for this request
        return await fetch(fallbackUrl, init);
      }
      return response;
    } catch (err: any) {
      if (fallbackUrl) {
        logger.warn({ err }, 'RPC Network error on primary, falling back to secondary');
        return await fetch(fallbackUrl, init);
      }
      throw err;
    }
  };
}
