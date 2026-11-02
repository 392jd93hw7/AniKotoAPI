/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — streamInfo.extractor.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * @description
 *   Handles server/stream resolution for episodes — fetches individual
 *   stream URLs, server lists via AJAX, and alternative servers from
 *   the nekostream mapper API.
 *
 * @exports
 *   extractStreamInfo, extractServerList, extractMapperServers
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import axios from "axios";
import * as cheerio from "cheerio";
import { headers } from "../configs/header.config.js";
import { fetchWithMirror, getWorkingMirror } from "../helper/mirror.helper.js";
import { fetchViaFlareSolverr, getProxyStatus } from "../helper/proxy.helper.js";
import { normalizeServerName } from "./streamResolver.extractor.js";

/**
 * Fetch an AniKoto AJAX endpoint with a consistent page/browser session.
 *
 * When FlareSolverr is configured, both the watch-page bootstrap and the AJAX
 * URL are navigated through the same persistent browser session on the
 * FlareSolverr host. FlareSolverr 3.x does not expose arbitrary custom headers;
 * if AniKoto requires X-Requested-With for these endpoints, the response will
 * be rejected explicitly instead of being mistaken for an empty server list.
 *
 * Without FlareSolverr, the existing direct-request + cookie-header path is
 * retained for backward compatibility.
 */
const fetchAniKotoAjax = async (mirror, watchSlug, path) => {
  let flareSolverrError = null;

  if (getProxyStatus().flaresolverr.enabled) {
    const bootstrapPaths = watchSlug
      ? [`/watch/${encodeURIComponent(watchSlug)}`, "/home"]
      : ["/home"];

    try {
      let bootstrap = null;
      let bootstrapError = null;

      for (const pagePath of bootstrapPaths) {
        try {
          bootstrap = await fetchViaFlareSolverr(new URL(pagePath, `${mirror}/`).href, {
            timeout: 45000,
          });
          break;
        } catch (error) {
          bootstrapError = error;
        }
      }

      if (!bootstrap) {
        throw new Error(
          `Could not establish browser session: ${bootstrapError?.message || "unknown error"}`
        );
      }

      const ajaxUrl = new URL(path, `${mirror}/`).href;
      const response = await fetchViaFlareSolverr(ajaxUrl, {
        timeout: 45000,
        sessionId: bootstrap.sessionId,
      });

      return response.data;
    } catch (error) {
      flareSolverrError = error;
      console.warn(`[STREAM] FlareSolverr extraction failed; trying direct session: ${error.message}`);
    }
  }

  // Direct fallback: keep the watch-page cookie and AJAX request on the same
  // API host/network path. This also preserves operation when FlareSolverr is
  // temporarily unavailable.
  try {
    let cookieHeader = "";
    const bootstrapUrl = watchSlug
      ? `${mirror}/watch/${encodeURIComponent(watchSlug)}`
      : `${mirror}/home`;

    try {
      const sessionRes = await axios.get(bootstrapUrl, {
        headers,
        timeout: 10000,
        maxRedirects: 5,
      });
      const setCookies = sessionRes.headers["set-cookie"];
      if (Array.isArray(setCookies)) {
        cookieHeader = setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
      }
    } catch {
      // Try the homepage below if the watch page did not establish a session.
    }

    if (!cookieHeader && watchSlug) {
      try {
        const fallbackRes = await axios.get(`${mirror}/home`, {
          headers,
          timeout: 10000,
          maxRedirects: 5,
        });
        const setCookies = fallbackRes.headers["set-cookie"];
        if (Array.isArray(setCookies)) {
          cookieHeader = setCookies.map((cookie) => cookie.split(";")[0]).join("; ");
        }
      } catch {
        // The AJAX request below will report the upstream failure.
      }
    }

    const requestHeaders = {
      ...headers,
      "X-Requested-With": "XMLHttpRequest",
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    };
    const { data } = await fetchWithMirror(path, { headers: requestHeaders });
    return data;
  } catch (directError) {
    if (flareSolverrError) {
      throw new Error(
        `FlareSolverr failed (${flareSolverrError.message}); direct fallback failed (${directError.message})`
      );
    }
    throw directError;
  }
};

const parseAniKotoAjaxResponse = (raw, endpointName) => {
  let parsed = raw;

  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      const preview = raw.slice(0, 120).replace(/\s+/g, " ");
      throw new Error(
        `AniKoto ${endpointName} endpoint returned non-JSON data. FlareSolverr navigation may not be sending the X-Requested-With AJAX header. Response: ${preview}`
      );
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`AniKoto ${endpointName} endpoint returned an invalid response`);
  }

  if (parsed.status && Number(parsed.status) >= 400) {
    throw new Error(`Upstream API error (${parsed.status}): ${parsed.result || parsed.message || "Unknown error"}`);
  }

  return parsed;
};

// ══════════════════════════════════════════════════════════════
// STREAM INFO EXTRACTOR
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Resolve a single stream URL from a linkId ----
/**
 * Fetches the actual stream URL and skip data for a given server link ID.
 * First establishes a session by fetching the watch page, then queries
 * the AJAX stream endpoint with proper session context.
 *
 * @param {string} linkId - The server link ID to resolve
 * @param {string} [watchSlug] - Optional watch page slug to establish session
 * @returns {Promise<Object>} Object with linkId, url, type, skipData (intro/outro timestamps)
 *
 * @example
 *   const stream = await extractStreamInfo("abc123", "one-piece-odmau");
 *   console.log(stream.url);      // direct video URL
 *   console.log(stream.skipData); // intro/outro skip ranges
 */
const extractStreamInfo = async (linkId, watchSlug = null) => {
  const mirror = await getWorkingMirror();
  const path = `/ajax/server?get=${encodeURIComponent(linkId)}`;
  const raw = await fetchAniKotoAjax(mirror, watchSlug, path);
  const data = parseAniKotoAjaxResponse(raw, "stream-detail");

  if (!data.result) {
    return { linkId, url: null, type: null, skipData: null };
  }

  const result = typeof data.result === "string"
    ? (() => {
        try {
          return JSON.parse(data.result);
        } catch {
          throw new Error("AniKoto stream-detail result was not valid JSON");
        }
      })()
    : data.result;

  if (!result || typeof result !== "object") {
    throw new Error("AniKoto stream-detail result had an invalid shape");
  }

  const streamUrl = result.url || null;
  const streamType = streamUrl?.includes(".m3u8") ? "hls" : streamUrl ? "mp4" : null;

  return {
    linkId,
    url: streamUrl,
    type: streamType,
    skipData: result.skip_data || null,
    backup: result.backup || null,
  };
};

// ══════════════════════════════════════════════════════════════
// SERVER LIST EXTRACTOR
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Fetch available servers for a set of episode IDs ----
/**
 * Retrieves the server list for the given episode IDs from the AJAX endpoint.
 * First establishes a session by fetching the watch page, then queries
 * the AJAX server list endpoint with proper session context.
 *
 * @param {string} episodeIds - Comma-separated or single episode ID string
 * @param {string} [watchSlug] - Optional watch page slug to establish session
 * @returns {Promise<Array>} Array of server objects with type, link_id, ep_id, etc.
 *
 * @example
 *   const servers = await extractServerList("12345", "one-piece-odmau");
 *   console.log(servers[0].link_id); // first server's link ID
 */
const extractServerList = async (episodeIds, watchSlug = null) => {
  if (episodeIds === undefined || episodeIds === null || String(episodeIds).trim() === "") {
    throw new Error("episodeIds is required");
  }

  const mirror = await getWorkingMirror();
  const path = `/ajax/server/list?servers=${encodeURIComponent(String(episodeIds))}`;
  const raw = await fetchAniKotoAjax(mirror, watchSlug, path);
  const parsed = parseAniKotoAjaxResponse(raw, "server-list");

  if (typeof parsed.result !== "string") {
    throw new Error("AniKoto server-list response did not contain the expected HTML result");
  }

  const $ = cheerio.load(parsed.result);
  const servers = [];

  $(".servers .type").each((_, typeEl) => {
    const type = $(typeEl).attr("data-type") || "sub";
    const label = $(typeEl).find("label").text().trim() || type.toUpperCase();

    $(typeEl).find("li[data-link-id]").each((__, li) => {
      const rawName = $(li).text().trim() || "";
      servers.push({
        type,
        typeLabel: label,
        ep_id: $(li).attr("data-ep-id") || "",
        link_id: $(li).attr("data-link-id") || "",
        cmid: $(li).attr("data-cmid") || "",
        sv_id: $(li).attr("data-sv-id") || "",
        name: rawName,
        normalizedName: normalizeServerName(rawName),
      });
    });
  });

  return servers;
};

// ══════════════════════════════════════════════════════════════
// MAPPER SERVERS EXTRACTOR
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Fetch alternative streaming servers from nekostream mapper API ----
/**
 * Queries the nekostream mapper API for alternative streaming providers
 * (sub and dub) for a given anime identified by MAL ID, slug, and timestamp.
 * Returns a flat array of server objects per provider.
 *
 * @param {number|string} malId - MyAnimeList ID for the anime
 * @param {string} slug - The anime slug on anikototv.to
 * @param {string|number} timestamp - Episode timestamp identifier
 * @returns {Promise<Array>} Array of server objects with provider, type, url, download fields
 *
 * @example
 *   const servers = await extractMapperServers(21, "one-piece", 1234567890);
 *   console.log(servers[0].provider); // "vidstreaming"
 *   console.log(servers[0].type);     // "sub" or "dub"
 */
const extractMapperServers = async (malId, slug, timestamp) => {
  try {
    if (!Number.isFinite(Number(malId))) throw new Error("Invalid malId");
    if (!/^[a-zA-Z0-9-]+$/.test(slug)) throw new Error("Invalid slug");
    if (!Number.isFinite(Number(timestamp))) throw new Error("Invalid timestamp");

    const path = `/ajax/mapper/${encodeURIComponent(malId)}/${encodeURIComponent(slug)}/${encodeURIComponent(timestamp)}`;
    const { data: rawData } = await fetchWithMirror(path);

    // NOTE: Parse JSON response first — fetchWithMirror returns raw text by default
    let data = rawData;
    if (typeof rawData === "string") {
      try { data = JSON.parse(rawData); } catch { data = {}; }
    }

    const servers = [];

    if (data && typeof data === "object") {
      for (const [provider, sources] of Object.entries(data)) {
        if (sources && sources.sub) {
          servers.push({
            provider,
            type: "sub",
            url: sources.sub.url || null,
            download: sources.sub.download || null
          });
        }
        if (sources && sources.dub) {
          servers.push({
            provider,
            type: "dub",
            url: sources.dub.url || null,
            download: sources.dub.download || null
          });
        }
      }
    }

    return servers;
  } catch (error) {
    return [];
  }
};

export { extractStreamInfo, extractServerList, extractMapperServers };

// ══════════════════════════════════════════════════════════════ END: streamInfo.extractor.js
