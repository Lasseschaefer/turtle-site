// Cloudflare Pages Middleware  ->  läuft bei JEDER Anfrage an deine Seite.
//
// 1) Gesperrte IPs bekommen eine 403-Seite ("Zugriff verweigert").
// 2) Normale Seitenaufrufe werden mit IP, Land, Browser und Zeit in der
//    Datenbank (Cloudflare D1, Bindung "DB") protokolliert.
//
// Ist die Datenbank noch nicht eingerichtet, läuft die Seite ganz normal weiter.
// Einträge werden nach RETENTION_DAYS Tagen automatisch gelöscht
// (den Wert bitte gleich in der Datenschutzerklärung angeben!).

const RETENTION_DAYS = 30;

let tablesReady = false;
async function ensureTables(db) {
  if (tablesReady) return;
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS visitors (ip TEXT PRIMARY KEY, country TEXT, user_agent TEXT, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1)"
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS blocked (ip TEXT PRIMARY KEY, note TEXT, blocked_at TEXT NOT NULL)"
    ),
  ]);
  tablesReady = true;
}

function blockedPage() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>403</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#000;background:#fff}
main{padding:24px;max-width:36ch}h1{font-weight:300;font-size:3rem;margin:0 0 12px;letter-spacing:-.04em}p{margin:6px 0;color:#555}</style></head>
<body><main><h1>403.</h1><p>Access denied.</p><p>Zugriff verweigert.</p></main></body></html>`;
  return new Response(html, {
    status: 403,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// Nur echte Seitenaufrufe zählen (nicht /api/twitch, keine Bilder usw.)
function isPageView(request) {
  if (request.method !== "GET") return false;
  const path = new URL(request.url).pathname;
  if (path !== "/" && path !== "/index.html") return false;
  return (request.headers.get("Accept") || "").includes("text/html");
}

async function logVisit(db, request, ip) {
  const now = new Date().toISOString();
  const country = (request.cf && request.cf.country) || request.headers.get("CF-IPCountry") || null;
  const userAgent = (request.headers.get("User-Agent") || "").slice(0, 300);

  await db
    .prepare(
      `INSERT INTO visitors (ip, country, user_agent, first_seen, last_seen, hits)
       VALUES (?1, ?2, ?3, ?4, ?4, 1)
       ON CONFLICT(ip) DO UPDATE SET
         country = excluded.country,
         user_agent = excluded.user_agent,
         last_seen = excluded.last_seen,
         hits = visitors.hits + 1`
    )
    .bind(ip, country, userAgent, now)
    .run();

  // Ab und zu alte Einträge aufräumen (Aufbewahrungsfrist)
  if (Math.random() < 0.02) {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await db.prepare("DELETE FROM visitors WHERE last_seen < ?").bind(cutoff).run();
  }
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const db = env.DB;
  const ip = request.headers.get("CF-Connecting-IP");

  // Keine Datenbank oder keine IP -> Seite ganz normal ausliefern
  if (!db || !ip) return next();

  try {
    await ensureTables(db);
    const hit = await db.prepare("SELECT 1 AS x FROM blocked WHERE ip = ?").bind(ip).first();
    if (hit) return blockedPage();
  } catch (err) {
    return next(); // Datenbankproblem? Besucher nicht aussperren.
  }

  const response = await next();

  if (response.ok && isPageView(request)) {
    context.waitUntil(logVisit(db, request, ip).catch(() => {}));
  }
  return response;
}
 
