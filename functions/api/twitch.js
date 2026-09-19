// Cloudflare Pages Function  ->  erreichbar unter  /api/twitch
// Holt Follower-Zahl + Live-Status von der offiziellen Twitch-API.
// Die Zugangsdaten stehen NICHT im Code, sondern als Secrets in Cloudflare:
//   TWITCH_CLIENT_ID     und     TWITCH_CLIENT_SECRET

const CHANNEL = "turtle_ttv1"; // Twitch-Login-Name (klein geschrieben)
const CACHE_MS = 60 * 1000; // Twitch höchstens 1x pro Minute fragen

// Werden zwischen Anfragen wiederverwendet, solange die Function "warm" ist.
let token = { value: null, expires: 0 };
let userId = null;
let cached = { data: null, expires: 0 };

async function getToken(env, force = false) {
  const now = Date.now();
  if (!force && token.value && now < token.expires) return token.value;

  const res = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error("token_" + res.status);

  const json = await res.json();
  // 5 Minuten Puffer, damit der Token nie mitten in einer Anfrage abläuft
  token = { value: json.access_token, expires: now + (json.expires_in - 300) * 1000 };
  return token.value;
}

async function helix(env, path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const accessToken = await getToken(env, attempt === 1);
    const res = await fetch("https://api.twitch.tv/helix" + path, {
      headers: {
        "Client-Id": env.TWITCH_CLIENT_ID,
        Authorization: "Bearer " + accessToken,
      },
    });
    // Token abgelaufen? Einmal mit neuem Token wiederholen.
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) throw new Error("helix_" + res.status);
    return res.json();
  }
}

function json(body, status = 200, cacheControl = "public, max-age=30") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
    },
  });
}

export async function onRequestGet({ env }) {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return json({ error: "missing_credentials" }, 500, "no-store");
  }

  const now = Date.now();
  if (cached.data && now < cached.expires) return json(cached.data);

  try {
    if (!userId) {
      const users = await helix(env, "/users?login=" + CHANNEL);
      if (!users.data || !users.data[0]) throw new Error("user_not_found");
      userId = users.data[0].id;
    }

    const [followers, streams] = await Promise.all([
      helix(env, "/channels/followers?broadcaster_id=" + userId + "&first=1"),
      helix(env, "/streams?user_id=" + userId),
    ]);

    const stream = streams.data && streams.data[0];
    const data = {
      followers: followers.total,
      live: Boolean(stream),
      title: stream ? stream.title : null,
      game: stream ? stream.game_name : null,
      viewers: stream ? stream.viewer_count : null,
      updated: new Date().toISOString(),
    };

    cached = { data, expires: now + CACHE_MS };
    return json(data);
  } catch (err) {
    // Twitch nicht erreichbar? Lieber die letzten bekannten Werte zeigen.
    if (cached.data) return json(cached.data);
    return json({ error: "twitch_unavailable", detail: String(err.message || err) }, 502, "no-store");
  }
}
