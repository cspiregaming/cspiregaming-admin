/**
 * Discord interactions helpers — signature verification and response constants.
 *
 * Uses Cloudflare Workers' native Web Crypto Ed25519 support; no tweetnacl.
 */

export const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
  APPLICATION_COMMAND_AUTOCOMPLETE: 4,
};

export const RESPONSE_TYPE = {
  PONG: 1,
  CHANNEL_MESSAGE: 4,
  DEFERRED_CHANNEL_MESSAGE: 5,
  DEFERRED_UPDATE_MESSAGE: 6,
  UPDATE_MESSAGE: 7,
  APPLICATION_COMMAND_AUTOCOMPLETE_RESULT: 8,
};

export const FLAGS = {
  EPHEMERAL: 1 << 6, // 64
};

/**
 * Verify the Ed25519 signature on an interaction request. Reads the body once
 * and returns it so the caller doesn't re-read (the signed payload is the
 * exact raw bytes Discord sent — re-stringifying breaks verification).
 *
 * Returns { ok: true, body, json } on success or { ok: false } otherwise.
 */
export async function verifyDiscordRequest(request, publicKeyHex) {
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');
  if (!signature || !timestamp || !publicKeyHex) return { ok: false };

  const body = await request.text();

  let valid = false;
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(publicKeyHex),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const sig = hexToBytes(signature);
    const msg = new TextEncoder().encode(timestamp + body);
    valid = await crypto.subtle.verify('Ed25519', key, sig, msg);
  } catch {
    return { ok: false };
  }

  if (!valid) return { ok: false };

  let json;
  try { json = JSON.parse(body); } catch { return { ok: false }; }
  return { ok: true, body, json };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}
