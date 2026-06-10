import {
  CLIENT_ID,
  DEVICE_AUTH_DEFAULT_INTERVAL_SECONDS,
  DEVICE_AUTH_REDIRECT_URI,
  DEVICE_AUTH_TIMEOUT_MS,
  DEVICE_AUTH_TOKEN_URL,
  DEVICE_AUTH_USERCODE_URL,
  DEVICE_AUTH_VERIFICATION_URL,
} from "./constants.js";

const DEVICE_AUTH_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "User-Agent": "vicoop-codex-cli/0.1.0",
  originator: "codex_cli_rs",
};

/**
 * Thrown when OpenAI reports that device-code login isn't enabled for this
 * account/client (HTTP 404 on the usercode request, or an `unauthorized_client`
 * error). The CLI surfaces a guide on how to enable it / what to do instead.
 */
export class DeviceFlowNotEnabledError extends Error {
  constructor() {
    super("Device-code login is not enabled for this OpenAI account.");
    this.name = "DeviceFlowNotEnabledError";
  }
}

/** Thrown when a Cloudflare bot challenge blocks the (non-browser) request. */
export class CloudflareChallengeError extends Error {
  constructor() {
    super("The device-authorization request was blocked by a Cloudflare challenge.");
    this.name = "CloudflareChallengeError";
  }
}

/** Thrown on any other device-flow failure (timeout, unexpected status, …). */
export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  /** Server-advertised poll interval, in seconds. */
  intervalSeconds: number;
  /** URL the user opens to enter `userCode`. */
  verificationUri: string;
}

export interface DeviceAuthCode {
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string;
}

interface RawResponse {
  status: number;
  headers: Headers;
  text: string;
}

async function postJson(url: string, body: unknown): Promise<RawResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: DEVICE_AUTH_HEADERS,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

/**
 * auth.openai.com sits behind Cloudflare. A non-browser POST can get an
 * intermittent bot challenge: 403 + `cf-mitigated: challenge` and/or an HTML
 * body. We detect it so we don't misreport it as an OAuth/enablement error.
 */
function isCloudflareChallenge(res: RawResponse): boolean {
  if (res.headers.get("cf-mitigated")) return true;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) return true;
  const head = res.text.slice(0, 64).toLowerCase();
  return head.includes("<!doctype html") || head.includes("<html");
}

function parseJson(res: RawResponse): Record<string, unknown> | null {
  if (res.text.length === 0) return {};
  try {
    const parsed = JSON.parse(res.text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Step 1 — request a one-time user code from OpenAI's device-auth endpoint.
 * Throws {@link DeviceFlowNotEnabledError} when the flow isn't available for
 * this account/client (HTTP 404, or an `unauthorized_client` error).
 */
export async function requestDeviceCode(): Promise<DeviceCode> {
  let res: RawResponse;
  try {
    res = await postJson(DEVICE_AUTH_USERCODE_URL, { client_id: CLIENT_ID });
  } catch (err) {
    throw new DeviceFlowError(
      `Could not reach the device-authorization endpoint: ${(err as Error).message ?? String(err)}`,
    );
  }

  // 404 on the *usercode* request is OpenAI's signal that device-code login is
  // not enabled for this account/client. (During polling, 404 instead means
  // "still pending" — see pollForAuthorizationCode.)
  if (res.status === 404) throw new DeviceFlowNotEnabledError();

  if (isCloudflareChallenge(res)) throw new CloudflareChallengeError();

  const json = parseJson(res);
  const errorCode = json ? asString(json.error) : undefined;
  if (errorCode === "unauthorized_client" || errorCode === "invalid_client") {
    // The OAuth client isn't permitted to use device flow — same outcome.
    throw new DeviceFlowNotEnabledError();
  }

  if (res.status < 200 || res.status >= 300 || !json) {
    throw new DeviceFlowError(
      `Device-authorization request failed (HTTP ${res.status})${res.text ? `: ${res.text.slice(0, 200)}` : ""}`,
    );
  }

  // codex-rs accepts both `user_code` and the `usercode` alias.
  const deviceAuthId = asString(json.device_auth_id ?? json.deviceAuthId);
  const userCode = asString(json.user_code ?? json.usercode ?? json.userCode);
  if (!deviceAuthId || !userCode) {
    throw new DeviceFlowError(
      `Device-authorization response missing device_auth_id / user_code: ${res.text.slice(0, 200)}`,
    );
  }

  const intervalRaw = Number(json.interval);
  const intervalSeconds =
    Number.isFinite(intervalRaw) && intervalRaw > 0
      ? intervalRaw
      : DEVICE_AUTH_DEFAULT_INTERVAL_SECONDS;

  return {
    deviceAuthId,
    userCode,
    intervalSeconds,
    verificationUri: DEVICE_AUTH_VERIFICATION_URL,
  };
}

/**
 * Step 2 — poll the device-token endpoint until the user authorizes (or the
 * 15-minute window expires). On success returns the OAuth authorization code +
 * PKCE verifier to exchange at the token endpoint.
 *
 * `onPending` is invoked once per poll while waiting (for a spinner/heartbeat).
 */
export async function pollForAuthorizationCode(
  device: DeviceCode,
  onPending?: () => void,
): Promise<DeviceAuthCode> {
  const deadline = Date.now() + DEVICE_AUTH_TIMEOUT_MS;
  const intervalMs = Math.max(1, device.intervalSeconds) * 1000;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new DeviceFlowError(
        "Device-code login timed out — the code is valid for 15 minutes. Run the command again for a fresh code.",
      );
    }

    let res: RawResponse;
    try {
      res = await postJson(DEVICE_AUTH_TOKEN_URL, {
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      });
    } catch {
      // Transient network error — keep polling within the deadline.
      onPending?.();
      await sleep(intervalMs);
      continue;
    }

    if (res.status >= 200 && res.status < 300) {
      const json = parseJson(res);
      const authorizationCode = json ? asString(json.authorization_code ?? json.authorizationCode) : undefined;
      const codeVerifier = json ? asString(json.code_verifier ?? json.codeVerifier) : undefined;
      if (!authorizationCode || !codeVerifier) {
        throw new DeviceFlowError(
          `Device token response is missing authorization_code / code_verifier: ${res.text.slice(0, 200)}`,
        );
      }
      return { authorizationCode, codeVerifier, redirectUri: DEVICE_AUTH_REDIRECT_URI };
    }

    // 403 / 404 during polling means "still pending". A Cloudflare challenge can
    // also surface as a 403 (HTML); we keep polling either way — it's transient
    // and the user can still complete sign-in in their own browser.
    if (res.status === 403 || res.status === 404) {
      onPending?.();
      await sleep(intervalMs);
      continue;
    }

    throw new DeviceFlowError(
      `Device token poll failed (HTTP ${res.status})${res.text ? `: ${res.text.slice(0, 200)}` : ""}`,
    );
  }
}
