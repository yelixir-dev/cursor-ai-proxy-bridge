export interface GeneratedCerts {
  caCrt: string;
  caKey: string;
  leafCrt: string;
  leafKey: string;
}

export declare function generateCerts(options: { out: string; days?: number }): GeneratedCerts;
