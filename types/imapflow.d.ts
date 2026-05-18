/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "imapflow" {
  export class ImapFlow {
    constructor(opts: any);
    connect(): Promise<void>;
    logout(): Promise<void>;
    getMailboxLock(mailbox: string): Promise<{ release(): void }>;
    search(query: any): Promise<number[]>;
    fetch(range: number | number[] | string, query: any): AsyncIterable<any>;
    fetchOne(uid: number, query: any): Promise<any>;
    messageFlagsAdd(range: any, flags: string[], opts?: any): Promise<void>;
  }
}
