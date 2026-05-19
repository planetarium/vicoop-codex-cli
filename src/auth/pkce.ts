import { randomBytes, createHash } from "node:crypto";

function base64UrlNoPad(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export function generatePkcePair(): PkcePair {
  const codeVerifier = base64UrlNoPad(randomBytes(64));
  const digest = createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64UrlNoPad(digest);
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return base64UrlNoPad(randomBytes(32));
}
