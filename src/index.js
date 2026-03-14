/* Trailerio Lite - Apple TV (FR) + IMDb (FR) only */

const MANIFEST = {
  id: 'io.trailerio.lite.fr',
  version: '1.0.0',
  name: 'Trailerio FR',
  description: 'French trailers - Apple TV + IMDb',
  logo: 'https://raw.githubusercontent.com/9mousaa/trailerio-lite/main/icon.png',
  resources: [{ name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt'] }],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

const CACHE_TTL = 86400;
const TMDB_API_KEY = 'bfe73358661a995b992ae9a812aa0d2f';

/* ---------- UTIL ---------- */

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

/* ---------- TMDB ---------- */

async function getTMDBMetadata(imdbId, type = 'movie') {
  try {
    const findRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );

    const findData = await findRes.json();

    let results = type === 'series'
      ? findData.tv_results
      : findData.movie_results;

    let actualType = type;

    if (!results || results.length === 0) {
      results = type === 'series'
        ? findData.movie_results
        : findData.tv_results;

      actualType = type === 'series' ? 'movie' : 'series';
    }

    if (!results || results.length === 0) return null;

    const tmdbId = results[0].id;
    const title = results[0].title || results[0].name;

    const extRes = await fetchWithTimeout(
      `https://api.themoviedb.org/3/${actualType === 'series' ? 'tv' : 'movie'}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`
    );

    const extData = await extRes.json();

    return {
      tmdbId,
      title,
      wikidataId: extData.wikidata_id,
      imdbId,
      actualType
    };

  } catch {
    return null;
  }
}

/* ---------- WIKIDATA ---------- */

async function getWikidataIds(wikidataId) {

  if (!wikidataId) return {};

  try {

    const res = await fetchWithTimeout(
      `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`
    );

    const data = await res.json();
    const entity = data.entities?.[wikidataId];

    if (!entity) return {};

    const appleTvMovieId = entity.claims?.P9586?.[0]?.mainsnak?.datavalue?.value;
    const appleTvShowId = entity.claims?.P9751?.[0]?.mainsnak?.datavalue?.value;

    return {
      appleTvId: appleTvMovieId || appleTvShowId,
      isAppleTvShow: !!appleTvShowId && !appleTvMovieId
    };

  } catch {
    return {};
  }
}

/* ---------- APPLE TV (FR) ---------- */

async function resolveAppleTV(imdbId, meta) {

  try {

    const appleId = meta?.wikidataIds?.appleTvId;

    if (!appleId) return null;

    const isShow = meta?.wikidataIds?.isAppleTvShow;

    const pageUrl = isShow
      ? `https://tv.apple.com/fr/show/${appleId}`
      : `https://tv.apple.com/fr/movie/${appleId}`;

    const pageRes = await fetchWithTimeout(pageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
      },
      redirect: 'follow'
    });

    const html = await pageRes.text();

    const hlsRaw = [...html.matchAll(/https:\/\/play[^"]*\.m3u8[^"]*/g)];

    if (hlsRaw.length === 0) return null;

    const url = hlsRaw[0][0].replace(/&amp;/g, '&');

    return {
      url,
      provider: 'Apple TV FR'
    };

  } catch {
    return null;
  }
}

/* ---------- IMDB (FR) ---------- */

async function resolveIMDb(imdbId) {

  try {

    const pageRes = await fetchWithTimeout(
      `https://www.imdb.com/title/${imdbId}/`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
        }
      }
    );

    const html = await pageRes.text();

    const videoMatch = html.match(/\/video\/(vi\d+)/);

    if (!videoMatch) return null;

    const videoRes = await fetchWithTimeout(
      `https://www.imdb.com/video/${videoMatch[1]}/`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
        }
      }
    );

    const videoHtml = await videoRes.text();

    const urlMatch = videoHtml.match(
      /"url":"(https:\/\/imdb-video\.media-imdb\.com[^"]+\.mp4[^"]*)"/
    );

    if (!urlMatch) return null;

    return {
      url: urlMatch[1].replace(/\\u0026/g, '&'),
      provider: 'IMDb FR'
    };

  } catch {
    return null;
  }
}

/* ---------- MAIN ---------- */

async function resolveTrailers(imdbId, type, cache) {

  const cacheKey = `trailer:fr:${imdbId}`;

  const cached = await cache.match(new Request(`https://cache/${cacheKey}`));

  if (cached) return cached.json();

  const tmdbMeta = await getTMDBMetadata(imdbId, type);

  const wikidataIds = await getWikidataIds(tmdbMeta?.wikidataId);

  const meta = { ...tmdbMeta, wikidataIds };

  const [appleTvResult, imdbResult] = await Promise.all([
    resolveAppleTV(imdbId, meta),
    resolveIMDb(imdbId)
  ]);

  const links = [appleTvResult, imdbResult]
    .filter(Boolean)
    .map((r, i) => ({
      trailers: r.url,
      provider: i === 0 ? `⭐ ${r.provider}` : r.provider
    }));

  const result = {
    title: meta?.title || imdbId,
    links
  };

  if (links.length > 0) {

    const response = new Response(JSON.stringify(result), {
      headers: { 'Cache-Control': `max-age=${CACHE_TTL}` }
    });

    await cache.put(new Request(`https://cache/${cacheKey}`), response.clone());
  }

  return result;
}

/* ---------- HANDLER ---------- */

export default {

  async fetch(request) {

    const url = new URL(request.url);
    const cache = caches.default;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json'
    };

    if (url.pathname === '/manifest.json') {
      return new Response(JSON.stringify(MANIFEST), { headers: corsHeaders });
    }

    const metaMatch = url.pathname.match(/^\/meta\/(movie|series)\/(.+)\.json$/);

    if (metaMatch) {

      const [, type, id] = metaMatch;
      const imdbId = id.split(':')[0];

      const result = await resolveTrailers(imdbId, type, cache);

      return new Response(JSON.stringify({
        meta: {
          id: imdbId,
          type,
          name: result.title,
          links: result.links
        }
      }), { headers: corsHeaders });
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: corsHeaders
    });
  }

};
