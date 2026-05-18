/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "mailparser" {
  export function simpleParser(source: any): Promise<{
    from?: {
      text?: string;
      value?: Array<{ address?: string; name?: string }>;
    };
    to?: { text?: string; value?: Array<{ address?: string; name?: string }> };
    subject?: string;
    text?: string;
    html?: string;
    date?: Date;
    messageId?: string;
    inReplyTo?: string;
    references?: string | string[];
    headers?: Map<string, any>;
  }>;
}
