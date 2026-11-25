/// <reference types="vite/client" />

interface TlsocInjectedReleaseIdentity {
  version: string;
  channel: 'testing' | 'stable';
  commitSha: string;
  buildTime: string;
}

declare const __TLSOC_RELEASE_IDENTITY__: Readonly<TlsocInjectedReleaseIdentity>;

/** Round 16 (SPEC D7): the newest What's new update id this build ships (whats-new.config.ts). */
declare const __AGENTIC_SOC_WHATS_NEW_LATEST__: string;

declare module '*.css?url' {
  const url: string;
  export default url;
}
