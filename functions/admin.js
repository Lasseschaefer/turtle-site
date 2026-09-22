// Admin-Seite  ->  erreichbar unter  /admin
// Geschützt mit Benutzername "admin" + dem Secret ADMIN_PASSWORD.
// Zeigt alle protokollierten IPs und erlaubt Sperren / Entsperren.

const RETENTION_DAYS = 30;

const MESSAGES = {
  blocked: "IP wurde gesperrt.",
  unblocked: "IP wurde entsperrt.",
  purged: "Alle Besucher-Einträge wurden gelöscht.",
  self: "Das ist deine eigene IP – die kannst du nicht sperren.",
  invalid: "Das ist keine gültige IP-Adresse.",
};

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

// HTML-Sonderzeichen entschärfen (Browser-Namen usw. kommen von außen!)
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const fmt = (iso) =>
  new Date(iso).toLocaleString("de-DE", { timeZone: "Europe/Berlin", dateStyle: "short", timeStyle: "medium" });

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function authorized(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
    decoded = new TextDecoder().decode(bytes);
  } catch (e) {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  const userOk = await safeEqual(decoded.slice(0, i), "admin");
  const passOk = await safeEqual(decoded.slice(i + 1), env.ADMIN_PASSWORD);
  return userOk && passOk;
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

function simplePage(title, text, status) {
  return html(
    `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:640px;margin:48px auto;padding:0 20px"><h1>${esc(title)}</h1><p>${text}</p></body></html>`,
    status
  );
}

function renderPage({ visitors, total, blocked, blockedSet, myIp, message }) {
  const rows = visitors
    .map((v) => {
      const isMe = v.ip === myIp;
      const isBlocked = blockedSet.has(v.ip);
      const action =
        isMe || isBlocked
          ? ""
          : `<form method="post" action="/admin"><input type="hidden" name="action" value="block"><input type="hidden" name="ip" value="${esc(v.ip)}"><button class="btn danger" type="submit">Sperren</button></form>`;
      return `<tr>
        <td class="mono">${esc(v.ip)}${isMe ? ' <span class="tag">du</span>' : ""}${isBlocked ? ' <span class="tag red">gesperrt</span>' : ""}</td>
        <td>${esc(v.country || "–")}</td>
        <td>${esc(fmt(v.first_seen))}</td>
        <td>${esc(fmt(v.last_seen))}</td>
        <td class="num">${Number(v.hits)}</td>
        <td class="ua" title="${esc(v.user_agent)}">${esc((v.user_agent || "").slice(0, 70))}</td>
        <td>${action}</td>
      </tr>`;
    })
    .join("");

  const blockedRows = blocked
    .map(
      (b) => `<tr>
        <td class="mono">${esc(b.ip)}</td>
        <td>${esc(b.note || "–")}</td>
        <td>${esc(fmt(b.blocked_at))}</td>
        <td><form method="post" action="/admin"><input type="hidden" name="action" value="unblock"><input type="hidden" name="ip" value="${esc(b.ip)}"><button class="btn" type="submit">Entsperren</button></form></td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="de"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>Admin – Turtle_ttv1</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#000;background:#fff;line-height:1.5}
  .wrap{max-width:1180px;margin:0 auto;padding:32px clamp(16px,4vw,48px) 64px}
  h1{font-weight:300;font-size:clamp(2rem,6vw,3.4rem);letter-spacing:-.04em;margin:0 0 4px}
  h2{font-weight:500;font-size:1.05rem;margin:44px 0 12px;padding-bottom:10px;border-bottom:1px solid #e5e5e5}
  p.sub{margin:0;color:#6f6f6f;font-size:14px}
  .msg{margin:20px 0 0;padding:12px 16px;border:1px solid #e5e5e5;border-left:3px solid #2fb463;border-radius:4px;font-size:14px}
  .scroll{overflow-x:auto;border:1px solid #e5e5e5;border-radius:4px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{padding:10px 14px;text-align:left;border-top:1px solid #e5e5e5;vertical-align:middle;white-space:nowrap}
  thead th{border-top:0;font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:#6f6f6f;font-weight:500}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
  .num{font-variant-numeric:tabular-nums}
  .ua{max-width:260px;overflow:hidden;text-overflow:ellipsis;color:#6f6f6f}
  .tag{display:inline-block;margin-left:6px;padding:1px 7px;border:1px solid #d0d0d0;border-radius:99px;font-size:11px;color:#555}
  .tag.red{border-color:#e5a3a3;color:#b42323}
  .btn{font:inherit;font-size:13px;padding:5px 12px;border:1px solid #000;border-radius:4px;background:#fff;color:#000;cursor:pointer}
  .btn:hover{background:#000;color:#fff}
  .btn.danger{border-color:#b42323;color:#b42323}
  .btn.danger:hover{background:#b42323;color:#fff}
  form{margin:0}
  .add{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
  .add input{font:inherit;font-size:14px;padding:7px 10px;border:1px solid #cfcfcf;border-radius:4px}
  .empty{padding:18px 14px;color:#6f6f6f;font-size:14px}
</style></head>
<body><div class="wrap">
  <h1>Admin.</h1>
  <p class="sub">Besucher-IPs werden nach ${RETENTION_DAYS} Tagen automatisch gelöscht. Deine aktuelle IP: <span class="mono">${esc(myIp || "unbekannt")}</span></p>
  ${message ? `<p class="msg">${esc(message)}</p>` : ""}

  <h2>Besucher (${total}${total > visitors.length ? `, die neuesten ${visitors.length} angezeigt` : ""})</h2>
  <div class="scroll"><table>
    <thead><tr><th>IP</th><th>Land</th><th>Erster Besuch</th><th>Letzter Besuch</th><th>Aufrufe</th><th>Browser</th><th></th></tr></thead>
    <tbody>${rows || ""}</tbody>
  </table>${rows ? "" : '<p class="empty">Noch keine Besucher protokolliert.</p>'}</div>

  <h2>Gesperrte IPs (${blocked.length})</h2>
  <div class="scroll"><table>
    <thead><tr><th>IP</th><th>Notiz</th><th>Gesperrt am</th><th></th></tr></thead>
    <tbody>${blockedRows}</tbody>
  </table>${blockedRows ? "" : '<p class="empty">Niemand gesperrt.</p>'}</div>

  <h2>IP manuell sperren</h2>
  <form class="add" method="post" action="/admin">
    <input type="hidden" name="action" value="block">
    <input name="ip" placeholder="z. B. 203.0.113.42" required maxlength="45" autocomplete="off">
    <input name="note" placeholder="Notiz (optional)" maxlength="100" autocomplete="off">
    <button class="btn danger" type="submit">Sperren</button>
  </form>

  <h2>Aufräumen</h2>
  <form method="post" action="/admin" onsubmit="return confirm('Wirklich ALLE Besucher-Einträge löschen? Gesperrte IPs bleiben gesperrt.')">
    <input type="hidden" name="action" value="purge">
    <button class="btn" type="submit">Alle Besucher-Einträge jetzt löschen</button>
  </form>
</div></body></html>`;
}

export async function onRequest({ request, env }) {
  const url = new URL(request.url);

  if (!env.ADMIN_PASSWORD) {
    return simplePage("Einrichtung unvollständig", "Das Secret <code>ADMIN_PASSWORD</code> fehlt in Cloudflare (oder es gab noch keinen neuen Deploy danach).", 500);
  }

  if (!(await authorized(request, env))) {
    return new Response("Login erforderlich", {
      status: 401,
      headers: {
        "WWW-Authenticate": 'Basic realm="Turtle_ttv1 Admin", charset="UTF-8"',
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  const db = env.DB;
  if (!db) {
    return simplePage("Datenbank fehlt", "Die D1-Datenbank ist nicht mit dem Namen <code>DB</code> an das Projekt gebunden (oder es gab noch keinen neuen Deploy danach).", 500);
  }
  await ensureTables(db);

  const myIp = request.headers.get("CF-Connecting-IP") || "";

  // ---------- Aktionen (Sperren / Entsperren / Löschen) ----------
  if (request.method === "POST") {
    if (request.headers.get("Origin") !== url.origin) {
      return new Response("Forbidden", { status: 403 });
    }
    const form = await request.formData();
    const action = String(form.get("action") || "");
    const ip = String(form.get("ip") || "").trim();
    let msg = "invalid";

    if (action === "purge") {
      await db.prepare("DELETE FROM visitors").run();
      msg = "purged";
    } else if (action === "block" || action === "unblock") {
      if (!/^[0-9a-fA-F:.]{2,45}$/.test(ip)) {
        msg = "invalid";
      } else if (action === "block") {
        if (ip === myIp) {
          msg = "self";
        } else {
          const note = String(form.get("note") || "").trim().slice(0, 100);
          await db
            .prepare("INSERT OR REPLACE INTO blocked (ip, note, blocked_at) VALUES (?1, ?2, ?3)")
            .bind(ip, note || null, new Date().toISOString())
            .run();
          msg = "blocked";
        }
      } else {
        await db.prepare("DELETE FROM blocked WHERE ip = ?").bind(ip).run();
        msg = "unblocked";
      }
    }
    return Response.redirect(url.origin + "/admin?msg=" + msg, 303);
  }

  // ---------- Seite anzeigen ----------
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await db.prepare("DELETE FROM visitors WHERE last_seen < ?").bind(cutoff).run();

  const visitors = (
    await db
      .prepare("SELECT ip, country, user_agent, first_seen, last_seen, hits FROM visitors ORDER BY last_seen DESC LIMIT 500")
      .all()
  ).results;
  const total = (await db.prepare("SELECT COUNT(*) AS n FROM visitors").first()).n;
  const blocked = (await db.prepare("SELECT ip, note, blocked_at FROM blocked ORDER BY blocked_at DESC").all()).results;

  return html(
    renderPage({
      visitors,
      total,
      blocked,
      blockedSet: new Set(blocked.map((b) => b.ip)),
      myIp,
      message: MESSAGES[url.searchParams.get("msg")] || "",
    })
  );
}
