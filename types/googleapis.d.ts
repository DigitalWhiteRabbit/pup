/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "googleapis" {
  export const google: {
    youtube(opts: { version: string; auth: string }): {
      search: { list(params: any): Promise<{ data: any }> };
      channels: { list(params: any): Promise<{ data: any }> };
      videos: { list(params: any): Promise<{ data: any }> };
      playlistItems: { list(params: any): Promise<{ data: any }> };
    };
  };
}
