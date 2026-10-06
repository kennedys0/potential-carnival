// Token-2022 Dangerous Extension Names (Normalized to Lowercase)
export const DANGEROUS_EXTENSIONS = [
  'transferfeeconfig',
  'permanentdelegate',
  'transferhook',
  'confidentialtransfermint',
  'nontransferable',
] as const;

export class Token2022Inspector {
  static inspectExtensions(extensionTypes: string[]): {
    hasDangerousExtensions: boolean;
    dangerousExtensionsFound: string[];
  } {
    const dangerousExtensionsFound = extensionTypes.filter((ext) =>
      DANGEROUS_EXTENSIONS.includes(ext.toLowerCase() as any)
    );

    return {
      hasDangerousExtensions: dangerousExtensionsFound.length > 0,
      dangerousExtensionsFound,
    };
  }
}
