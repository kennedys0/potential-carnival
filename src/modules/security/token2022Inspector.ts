import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, ExtensionType, getExtensionTypes, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { FactorResult } from './scoreCalculator';

export const DANGEROUS_EXTENSIONS = [
  'TransferFeeConfig',
  'PermanentDelegate',
  'TransferHook',
  'ConfidentialTransferMint',
  'NonTransferable',
  'DefaultAccountState'
];

export class Token2022Inspector {
  static async inspectExtensions(connection: Connection, mintPubkey: PublicKey, programId: PublicKey): Promise<FactorResult<string[]>> {
    try {
      if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
        const mintInfo = await getMint(connection, mintPubkey, 'confirmed', TOKEN_2022_PROGRAM_ID);
        // getExtensionTypes requires the tlvData which is part of mintInfo if retrieved correctly.
        // spl-token getMint doesn't return raw data with extensions easily in older versions, but let's assume it works or we read account info
        const accountInfo = await connection.getAccountInfo(mintPubkey);
        if (!accountInfo) throw new Error('Mint not found');
        
        const extensionTypes = getExtensionTypes(accountInfo.data);
        const typesStr = extensionTypes.map(e => ExtensionType[e]);
        
        const dangerousExtensionsFound = typesStr.filter((ext) =>
          DANGEROUS_EXTENSIONS.includes(ext)
        );

        return {
          value: dangerousExtensionsFound,
          status: 'OK',
          source: 'Token-2022 On-Chain Data'
        };
      } else {
        return {
          value: [],
          status: 'OK',
          source: 'Token Program (Classic)'
        };
      }
    } catch (e: any) {
      return {
        value: null,
        status: 'UNAVAILABLE',
        source: `Error: ${e.message}`
      };
    }
  }
}
