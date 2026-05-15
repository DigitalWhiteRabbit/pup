import { NextResponse } from "next/server";

/**
 * GET /api/voice/ice-servers
 *
 * Returns ICE server configuration for WebRTC.
 * Includes STUN (free, always) + TURN (if configured).
 *
 * TURN is required for users behind strict NAT/firewalls/VPN.
 * Without TURN, ~15-20% of connections fail in production.
 *
 * Supported providers:
 * - Metered.ca (TURN_PROVIDER=metered) — free 500MB/mo
 * - Custom (TURN_PROVIDER=custom) — self-hosted coturn
 * - Twilio (TURN_PROVIDER=twilio) — paid
 */

export async function GET() {
  const iceServers: RTCIceServer[] = [
    // STUN — always included (free, Google)
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ];

  const provider = process.env.TURN_PROVIDER;

  if (provider === "metered") {
    const domain = process.env.METERED_DOMAIN ?? "global.relay.metered.ca";
    const apiKey = process.env.METERED_API_KEY ?? "";

    // Try fetching dynamic credentials first
    let fetched = false;
    if (apiKey) {
      try {
        const res = await fetch(
          `https://${domain}/api/v1/turn/credentials?apiKey=${apiKey}`,
          { next: { revalidate: 3600 } },
        );
        if (res.ok) {
          const servers = (await res.json()) as Array<{
            urls: string | string[];
            username?: string;
            credential?: string;
          }>;
          if (Array.isArray(servers) && servers.length > 0) {
            iceServers.push(...servers);
            fetched = true;
          }
        }
      } catch {
        /* fallback below */
      }
    }

    // Fallback: use Metered's standard TURN servers with domain
    if (!fetched && domain) {
      iceServers.push(
        { urls: `stun:${domain}:80` },
        { urls: `turn:${domain}:80`, username: "open", credential: "open" },
        { urls: `turn:${domain}:443`, username: "open", credential: "open" },
        { urls: `turns:${domain}:443`, username: "open", credential: "open" },
      );
    }
  } else if (provider === "custom") {
    // Self-hosted coturn
    const url = process.env.TURN_URL;
    const user = process.env.TURN_USERNAME;
    const pass = process.env.TURN_PASSWORD;
    if (url && user && pass) {
      iceServers.push({
        urls: url,
        username: user,
        credential: pass,
      });
    }
  } else if (provider === "twilio" && process.env.TWILIO_ACCOUNT_SID) {
    // Twilio NTS
    try {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      const token = process.env.TWILIO_AUTH_TOKEN;
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Tokens.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
          },
        },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          ice_servers: Array<{
            urls: string;
            username: string;
            credential: string;
          }>;
        };
        iceServers.push(...data.ice_servers);
      }
    } catch {
      /* fallback */
    }
  }

  return NextResponse.json({ iceServers });
}
