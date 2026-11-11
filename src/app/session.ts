// Login sessions as signed tokens kept in a cookie. Nothing is stored on the server: the token says
// "this account, until this time" and carries a signature only the server can make. A changed token,
// an expired one, or one signed with another secret is rejected.

import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_SECONDS = 7 * 24 * 60 * 60;

const mac = (body: string, secret: string): string => createHmac("sha256", secret).update(body).digest("base64url");

export function signSession(userId: string, secret: string, nowMs: number = Date.now(), ttlSeconds: number = SESSION_SECONDS): string {
  const body = `${userId}.${Math.floor(nowMs / 1000) + ttlSeconds}`;
  return `${body}.${mac(body, secret)}`;
}

/** Returns the account id, or null if the token is missing, changed, expired, or made with another secret. */
export function verifySession(token: string | undefined, secret: string, nowMs: number = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, exp, given] = parts as [string, string, string];
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^\d+$/.test(exp)) return null;
  const expected = Buffer.from(mac(`${userId}.${exp}`, secret));
  const got = Buffer.from(given);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return Number(exp) * 1000 > nowMs ? userId : null;
}
