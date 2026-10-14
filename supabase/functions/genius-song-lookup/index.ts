const allowedOrigins = new Set(["https://musick-sage.vercel.app"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin !== null && (
    allowedOrigins.has(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
  );
  return {
    ...(allowed && origin !== null ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

function jsonResponse(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" }
  });
}

function normalize(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

Deno.serve(async request => {
  const headers = corsHeaders(request.headers.get("origin"));
  if (request.method === "OPTIONS") return new Response("ok", { headers });
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405, headers);

  const accessToken = Deno.env.get("GENIUS_ACCESS_TOKEN");
  if (!accessToken) return jsonResponse({ error: "Genius lookup is not configured on the server." }, 503, headers);

  let body: { title?: unknown; artist?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON." }, 400, headers);
  }
  if (typeof body.title !== "string" || typeof body.artist !== "string" ||
      !body.title.trim() || !body.artist.trim() || body.title.length > 200 || body.artist.length > 200) {
    return jsonResponse({ error: "Provide a track title and artist, each no longer than 200 characters." }, 400, headers);
  }

  const query = `${body.title.trim()} ${body.artist.trim()}`;
  let upstream: Response;
  try {
    upstream = await fetch(`https://api.genius.com/search?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" }
    });
  } catch (error) {
    console.error("Genius API request could not be completed.", error);
    return jsonResponse({ error: "Genius song search is temporarily unavailable." }, 502, headers);
  }
  if (!upstream.ok) {
    console.error("Genius API request failed with HTTP", upstream.status);
    return jsonResponse({ error: "Genius song search is temporarily unavailable." }, 502, headers);
  }

  let response: unknown;
  try {
    response = await upstream.json();
  } catch (error) {
    console.error("Genius API returned invalid JSON.", error);
    return jsonResponse({ error: "Genius returned an invalid song search response." }, 502, headers);
  }
  const responseBody = isRecord(response) && isRecord(response.response) ? response.response : null;
  const hits = responseBody && Array.isArray(responseBody.hits) ? responseBody.hits : [];
  const requestedTitle = normalize(body.title);
  const requestedArtist = normalize(body.artist);
  const ranked = hits.flatMap(hit => {
    if (!isRecord(hit) || !isRecord(hit.result)) return [];
    const song = hit.result;
    const primaryArtist = isRecord(song.primary_artist) ? song.primary_artist : null;
    if (typeof song.title !== "string" || typeof primaryArtist?.name !== "string" ||
        typeof song.url !== "string" || !/^https:\/\/genius\.com\//i.test(song.url)) return [];
    const title = normalize(song.title);
    const artist = normalize(primaryArtist.name);
    const titleMatch = title === requestedTitle || title.startsWith(requestedTitle) || requestedTitle.startsWith(title);
    const artistMatch = artist === requestedArtist || artist.includes(requestedArtist) || requestedArtist.includes(artist);
    return titleMatch && artistMatch ? [{ title: song.title, artist: primaryArtist.name, url: song.url }] : [];
  });

  return jsonResponse({ song: ranked[0] || null }, 200, headers);
});
