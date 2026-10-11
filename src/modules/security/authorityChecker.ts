import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { FactorResult } from './scoreCalculator';

export interface AuthorityCheckResult {
  mintAuthorityActive: FactorResult<boolean>;
  freezeAuthorityActive: FactorResult<boolean>;
  programId: PublicKey;
  totalSupplyRaw: bigint;
}

export class AuthorityChecker {
  constructor(private readonly connection: Connection) {}

  async checkAuthorities(mintAddress: string): Promise<AuthorityCheckResult> {
    try {
      const mintPubkey = new PublicKey(mintAddress);
      const accountInfo = await this.connection.getAccountInfo(mintPubkey);
      
      if (!accountInfo) {
        throw new Error('Mint account not found');
      }

      const programId = accountInfo.owner;
      const isToken2022 = programId.equals(TOKEN_2022_PROGRAM_ID);
      const isClassic = programId.equals(TOKEN_PROGRAM_ID);
      
      if (!isToken2022 && !isClassic) {
         throw new Error('Not a valid SPL Token or Token-2022 mint');
      }

      const mintInfo = await getMint(this.connection, mintPubkey, 'confirmed', programId);
      return {
        programId,
        totalSupplyRaw: mintInfo.supply,
        mintAuthorityActive: {
          value: mintInfo.mintAuthority !== null,
          status: 'OK',
          source: isToken2022 ? 'Token-2022 On-Chain' : 'SPL Token On-Chain'
        },
        freezeAuthorityActive: {
          value: mintInfo.freezeAuthority !== null,
          status: 'OK',
          source: isToken2022 ? 'Token-2022 On-Chain' : 'SPL Token On-Chain'
        }
      };
    } catch (e: any) {
      return {
        programId: TOKEN_PROGRAM_ID, // Fallback
        totalSupplyRaw: 0n,
        mintAuthorityActive: {
          value: null,
          status: 'UNAVAILABLE',
          source: `Error: ${e.message}`
        },
        freezeAuthorityActive: {
          value: null,
          status: 'UNAVAILABLE',
          source: `Error: ${e.message}`
        }
      };
    }
  }
}
