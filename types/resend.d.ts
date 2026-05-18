/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "resend" {
  export class Resend {
    constructor(apiKey: string);
    emails: {
      send(opts: {
        from: string;
        to: string[];
        subject: string;
        html: string;
        headers?: Record<string, string>;
      }): Promise<{
        data: { id: string } | null;
        error: { message: string } | null;
      }>;
    };
  }
}
