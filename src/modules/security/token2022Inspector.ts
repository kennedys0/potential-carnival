import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, ExtensionType, getExtensionTypes, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { FactorResult } from './scoreCalculator';

export const DANGEROUS_EXTENSIONS = [
  'TransferFeeConfig',
  'PermanentDelegate',
  'TransferHook',
  'ConfidentialTransferMint',
  'NonTransferable',
  'DefaultAccountState',
  'PausableConfig',
];

export class Token2022Inspector {
  static async inspectExtensions(connection: Connection, mintPubkey: PublicKey, programId: PublicKey): Promise<FactorResult<string[]>> {
    try {
      if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
        const mintInfo = await getMint(connection, mintPubkey, 'confirmed', TOKEN_2022_PROGRAM_ID);
        const extensionTypes = getExtensionTypes(mintInfo.tlvData);
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
