import { Connection, PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';

export interface AuthorityCheckResult {
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

export class AuthorityChecker {
  constructor(private readonly connection: Connection) {}

  async checkAuthorities(mintAddress: string): Promise<AuthorityCheckResult> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const mintInfo = await getMint(this.connection, mintPubkey);

      return {
        mintAuthorityActive: mintInfo.mintAuthority !== null,
        freezeAuthorityActive: mintInfo.freezeAuthority !== null,
        mintAuthority: mintInfo.mintAuthority?.toBase58() || null,
        freezeAuthority: mintInfo.freezeAuthority?.toBase58() || null,
      };
    } catch {
      // Fallback safe assumption on error
      return {
        mintAuthorityActive: true,
        freezeAuthorityActive: true,
        mintAuthority: 'UNKNOWN',
        freezeAuthority: 'UNKNOWN',
      };
    }
  }
}
