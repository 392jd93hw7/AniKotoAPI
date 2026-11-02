/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — proxy.helper.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * @description
 *   Proxy helper for bypassing Cloudflare bot protection.
 *   Supports ScraperAPI (premium) and FlareSolverr (self-hosted).
 *   Automatically routes requests through proxy when direct requests fail.
 *
 * @exports
 *   fetchWithProxy, fetchViaFlareSolverr, getFlareSolverrSession,
 *   destroyFlareSolverrSession, getProxyStatus
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import axios from "axios";
import { headers } from "../configs/header.config.js";

// ══════════════════════════════════════════════════════════════
// PROXY CONFIGURATION
// ══════════════════════════════════════════════════════════════

const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const FLARESOLVERR_URL = (process.env.FLARESOLVERR_URL || "").replace(/\/+$/, "");
const FLARESOLVERR_SESSION_IDLE_MS = Number.parseInt(process.env.FLARESOLVERR_SESSION_IDLE_MS || "900000", 10);
const FLARESOLVERR_MAX_TIMEOUT = Number.parseInt(process.env.FLARESOLVERR_MAX_TIMEOUT || "60000", 10);

let flareSolverrSessionId = null;
let flareSolverrLastUsedAt = 0;
let flareSolverrSessionPromise = null;

// ScraperAPI endpoint
const SCRAPER_API_URL = "http://api.scraperapi.com";

// ══════════════════════════════════════════════════════════════
// PROXY STATUS
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Get proxy configuration status ----
/**
 * Returns current proxy configuration status
 * @returns {Object} Proxy status with enabled/disabled and available methods
 */
function getProxyStatus() {
  return {
    scraperApi: {
      enabled: !!SCRAPER_API_KEY,
      configured: !!SCRAPER_API_KEY,
    },
    flaresolverr: {
      enabled: !!FLARESOLVERR_URL,
      configured: !!FLARESOLVERR_URL,
      url: FLARESOLVERR_URL || null,
    },
    anyEnabled: !!SCRAPER_API_KEY || !!FLARESOLVERR_URL,
  };
}

// ══════════════════════════════════════════════════════════════
// SCRAPERAPI
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: ScraperAPI proxy fetch ----
/**
 * Fetch a URL through ScraperAPI (premium residential IPs)
 * @param {string} url - Target URL
 * @param {Object} options - Request options
 * @returns {Promise<{data: string, proxy: string}>}
 */
async function fetchViaScraperApi(url, options = {}) {
  const { timeout = 30000, returnType = "text" } = options;

  const params = {
    api_key: SCRAPER_API_KEY,
    url: url,
    render: "false",
  };

  const response = await axios.get(SCRAPER_API_URL, {
    params,
    timeout,
    responseType: returnType === "text" ? "text" : "json",
  });

  return {
    data: response.data,
    proxy: "scraperapi",
  };
}

// ══════════════════════════════════════════════════════════════
// FLARESOLVERR
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: FlareSolverr proxy fetch ----
/**
 * Fetch a URL through FlareSolverr (self-hosted browser)
 * @param {string} url - Target URL
 * @param {Object} options - Request options
 * @returns {Promise<{data: string, proxy: string}>}
 */
/**
 * Send a command to the FlareSolverr v1 API.
 * FlareSolverr 3.x manages browser cookies inside its persistent browser session. Its API
 * does not expose arbitrary per-request headers, so callers must not assume
 * that X-Requested-With or other custom AJAX headers can be injected.
 */
async function sendFlareSolverrCommand(payload, timeout = 70000) {
  if (!FLARESOLVERR_URL) {
    throw new Error("FlareSolverr is not configured (FLARESOLVERR_URL is missing)");
  }

  const response = await axios.post(
    `${FLARESOLVERR_URL}/v1`,
    payload,
    {
      headers: { "Content-Type": "application/json" },
      timeout,
    }
  );

  if (response.data?.status !== "ok") {
    throw new Error(`FlareSolverr error: ${response.data?.message || "Unknown FlareSolverr error"}`);
  }

  return response.data;
}

/**
 * Destroy the current FlareSolverr session, if one exists.
 * This is also used to recover from a server-side expired session.
 */
async function destroyFlareSolverrSession(sessionId = flareSolverrSessionId) {
  if (!sessionId) return;

  if (sessionId === flareSolverrSessionId) {
    flareSolverrSessionId = null;
    flareSolverrLastUsedAt = 0;
  }

  try {
    await sendFlareSolverrCommand(
      { cmd: "sessions.destroy", session: sessionId },
      15000
    );
  } catch (error) {
    // A session may already have expired on the FlareSolverr side.
    console.log(`[PROXY] FlareSolverr session cleanup: ${error.message}`);
  }
}

/**
 * Return a reusable FlareSolverr browser session.
 * Concurrent first requests share one session-creation promise.
 */
async function getFlareSolverrSession() {
  if (!FLARESOLVERR_URL) {
    throw new Error("FlareSolverr is not configured (FLARESOLVERR_URL is missing)");
  }

  const isFresh =
    flareSolverrSessionId &&
    Date.now() - flareSolverrLastUsedAt < FLARESOLVERR_SESSION_IDLE_MS;

  if (isFresh) return flareSolverrSessionId;
  if (flareSolverrSessionPromise) return flareSolverrSessionPromise;

  flareSolverrSessionPromise = (async () => {
    if (flareSolverrSessionId) {
      await destroyFlareSolverrSession(flareSolverrSessionId);
    }

    const result = await sendFlareSolverrCommand(
      { cmd: "sessions.create" },
      20000
    );

    if (!result.session || typeof result.session !== "string") {
      throw new Error("FlareSolverr did not return a session ID");
    }

    flareSolverrSessionId = result.session;
    flareSolverrLastUsedAt = Date.now();
    console.log("[PROXY] FlareSolverr browser session created");
    return flareSolverrSessionId;
  })();

  try {
    return await flareSolverrSessionPromise;
  } finally {
    flareSolverrSessionPromise = null;
  }
}

/**
 * Fetch a URL through a persistent FlareSolverr browser session.
 *
 * @param {string} url - Absolute target URL
 * @param {Object} options - Request options
 * @param {number} options.timeout - Request timeout in milliseconds
 * @param {string} options.returnType - "text" or "json"
 * @param {string} options.sessionId - Existing session ID to reuse
 * @returns {Promise<{data: string|Object, proxy: string, status: number, sessionId: string}>}
 */
async function fetchViaFlareSolverr(url, options = {}) {
  const {
    timeout = FLARESOLVERR_MAX_TIMEOUT,
    returnType = "text",
    sessionId: suppliedSessionId = null,
  } = options;

  let targetUrl;
  try {
    const parsedUrl = new URL(url);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("Unsupported URL protocol");
    targetUrl = parsedUrl.href;
  } catch {
    throw new Error("FlareSolverr requires an absolute HTTP(S) URL");
  }

  const requestTimeout = Math.max(10000, Math.min(timeout, FLARESOLVERR_MAX_TIMEOUT));
  const sendRequest = async (activeSessionId) => {
    const result = await sendFlareSolverrCommand(
      {
        cmd: "request.get",
        url: targetUrl,
        session: activeSessionId,
        maxTimeout: requestTimeout,
      },
      requestTimeout + 15000
    );

    const solution = result.solution || {};
    const status = Number(solution.status || 200);
    if (status < 200 || status >= 400) {
      const error = new Error(`FlareSolverr target returned HTTP ${status}`);
      error.status = status;
      throw error;
    }

    let data = solution.response;
    if (data === undefined || data === null) {
      throw new Error("FlareSolverr returned an empty response body");
    }

    if (typeof data === "string" && (
      data.includes("Just a moment...") ||
      data.includes("Checking your browser")
    )) {
      throw new Error("FlareSolverr returned a browser challenge page");
    }

    if (returnType === "json" && typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        throw new Error("FlareSolverr response was not valid JSON");
      }
    }

    flareSolverrLastUsedAt = Date.now();
    return {
      data,
      proxy: "flaresolverr",
      status,
      sessionId: activeSessionId,
    };
  };

  const activeSessionId = suppliedSessionId || await getFlareSolverrSession();

  try {
    return await sendRequest(activeSessionId);
  } catch (error) {
    const invalidSession = /session.*(?:not found|does not exist|invalid)|unknown session/i.test(error.message);
    if (!invalidSession) throw error;

    if (activeSessionId === flareSolverrSessionId) {
      flareSolverrSessionId = null;
      flareSolverrLastUsedAt = 0;
    }

    console.log("[PROXY] FlareSolverr session expired; creating a new session");
    const replacementSessionId = await getFlareSolverrSession();
    return sendRequest(replacementSessionId);
  }
}

// ══════════════════════════════════════════════════════════════
// UNIFIED PROXY FETCH
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Fetch with automatic proxy fallback ----
/**
 * Fetch a URL with automatic proxy fallback when direct requests fail.
 * Tries direct first, then falls back to configured proxies.
 *
 * @param {string} url - Target URL
 * @param {Object} options - Request options
 * @param {Object} options.requestHeaders - Custom headers for direct request
 * @param {number} options.timeout - Request timeout (default: 15000ms)
 * @param {string} options.returnType - Response type: "text" or "json"
 * @returns {Promise<{data: string, proxy: string}>}
 */
async function fetchWithProxy(url, options = {}) {
  const {
    requestHeaders = headers,
    timeout = 15000,
    returnType = "text",
  } = options;

  // 1. Try direct request first
  try {
    const response = await axios.get(url, {
      headers: requestHeaders,
      timeout,
      responseType: returnType === "text" ? "text" : "json",
    });

    if (response.status === 200) {
      // Check if response is a valid result (not a Cloudflare block)
      const data = response.data;
      if (typeof data === "string" && data.includes("Just a moment...")) {
        throw new Error("Cloudflare challenge detected");
      }
      if (typeof data === "string" && data.includes("Checking your browser")) {
        throw new Error("Cloudflare challenge detected");
      }

      return { data, proxy: "direct" };
    }
  } catch (error) {
    // If ScraperAPI or FlareSolverr configured, try them
    if (!SCRAPER_API_KEY && !FLARESOLVERR_URL) {
      throw error;
    }
  }

  // 2. Try ScraperAPI if configured
  if (SCRAPER_API_KEY) {
    try {
      console.log(`[PROXY] Trying ScraperAPI for: ${url}`);
      return await fetchViaScraperApi(url, { timeout, returnType });
    } catch (error) {
      console.log(`[PROXY] ScraperAPI failed: ${error.message}`);
    }
  }

  // 3. Try FlareSolverr if configured
  if (FLARESOLVERR_URL) {
    try {
      console.log(`[PROXY] Trying FlareSolverr for: ${url}`);
      return await fetchViaFlareSolverr(url, { timeout, returnType });
    } catch (error) {
      console.log(`[PROXY] FlareSolverr failed: ${error.message}`);
    }
  }

  // 4. All methods failed — try direct one more time with higher timeout
  try {
    const response = await axios.get(url, {
      headers: requestHeaders,
      timeout: timeout * 2,
      responseType: returnType === "text" ? "text" : "json",
    });

    return { data: response.data, proxy: "direct-retry" };
  } catch (error) {
    throw new Error(`All fetch methods failed for ${url}: ${error.message}`);
  }
}

export { fetchWithProxy, fetchViaFlareSolverr, getFlareSolverrSession, destroyFlareSolverrSession, getProxyStatus };

// ══════════════════════════════════════════════════════════════ END: proxy.helper.js
