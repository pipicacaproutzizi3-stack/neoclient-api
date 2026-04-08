// NeoClient API (Railway) - index.js
// - Presence (with IP + TTL), cosmetics per-server, WebSocket push to subscribers
// - Accepts oldKey & name on /register to migrate cosmetics and creates aliases (name + offline-UUID)
// - Support des cosmétiques au format type/ID numérique ET au format nom
// - VERSION CHECK: endpoint pour vérifier les mises à jour du client
// - EMOTES: synchronisation des emotes en temps réel entre joueurs NeoClient
// - Endpoints:
//   POST  /register
//   POST  /unregister
//   GET   /servers/:serverId/neoclients
//   POST  /servers/:serverId/cosmetics (format tableau de noms)
//   GET   /servers/:serverId/cosmetics
//   POST  /servers/:serverId/emotes    (NOUVEAU)
//   GET   /servers/:serverId/emotes    (NOUVEAU)
//   POST  /cosmetics/update (format type/ID)
//   POST  /cosmetics/delete
//   GET   /version
//   GET   /download-url
//   WS    /ws (subscribe with { action: "subscribe", server_id })
//   GET   /healthz, /debug/store
//
// Env:
//   PORT, TTL_MS (ms), MIGRATE_WINDOW_MS (ms), ADMIN_SECRET (optional), DEFAULT_CAPE_ID (optional)

const express = require('express');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
app.use(bodyParser.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 10 * 1000, max: 30 }));

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const TTL_MS = process.env.TTL_MS ? parseInt(process.env.TTL_MS, 10) : 60 * 1000;
const MIGRATE_WINDOW_MS = process.env.MIGRATE_WINDOW_MS ? parseInt(process.env.MIGRATE_WINDOW_MS, 10) : 15 * 1000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
const DEFAULT_CAPE_ID = (process.env.DEFAULT_CAPE_ID || 'neo_cape').toLowerCase();

/* ---------- Version Management ---------- */
const CLIENT_VERSION = "1.0.0";
const UPDATE_CONTENT = [
  "- Premiere version stable de NeoClient",
  "- Interface holographique amelioree",
  "- Systeme de cosmetiques integre",
  "- Correction de bugs de stabilite",
  "- Optimisations de performance"
].join("\\n");

const DOWNLOAD_URL = "https://github.com/TON_USERNAME/NeoClient/releases/latest";

/* ---------- Cosmetic ID/Name Mappings ---------- */
const ID_TO_NAME = {
  // Type 1: Capes
  1:  'snow_cape',
  2:  'normal_cape',
  3:  'thunder_cape',
  4:  'bad_wolf_cape',
  5:  'starry_sunset_cape',
  10: 'anime_girl_cape',
  11: 'jumping_frog_cape',
  14: 'waving_cape',
  15: 'chillin_boy',
  17: 'neo_cape',

  // Type 2: Hats
  6:  'top_hat',
  13: 'wool_hat',

  // Type 3: Wings
  7:  'dragon_wing',
  8:  'satan_wing',
  9:  'dragon_baby_wing',
  12: 'dragon_obsidian_wing',

  // Type 4: Pets
  16: 'wolf_pet'
};

const NAME_TO_TYPE_ID = {
  // Type 1: Capes
  'snow_cape':          { type: 1, id: 1 },
  'normal_cape':        { type: 1, id: 2 },
  'thunder_cape':       { type: 1, id: 3 },
  'bad_wolf_cape':      { type: 1, id: 4 },
  'starry_sunset_cape': { type: 1, id: 5 },
  'anime_girl_cape':    { type: 1, id: 10 },
  'jumping_frog_cape':  { type: 1, id: 11 },
  'waving_cape':        { type: 1, id: 14 },
  'chillin_boy':        { type: 1, id: 15 },
  'neo_cape':           { type: 1, id: 17 },

  // Type 2: Hats
  'top_hat':  { type: 2, id: 6 },
  'wool_hat': { type: 2, id: 13 },

  // Type 3: Wings
  'dragon_wing':          { type: 3, id: 7 },
  'satan_wing':           { type: 3, id: 8 },
  'dragon_baby_wing':     { type: 3, id: 9 },
  'dragon_obsidian_wing': { type: 3, id: 12 },

  // Type 4: Pets
  'wolf_pet': { type: 4, id: 16 }
};

/* ---------- in-memory stores ---------- */
// presence:  Map<serverId, Map<uuid, { ts:Number, ip:String }>>
const storePresence  = new Map();
// cosmetics: Map<serverId, Map<key, Array<string>>>
const storeCosmetics = new Map();
// emotes:    Map<serverId, Map<uuid, string>>
const storeEmotes    = new Map();

/* ---------- helpers ---------- */
function now() { return Date.now(); }

// Java-compatible OfflinePlayer UUID (UUID.nameUUIDFromBytes("OfflinePlayer:"+name))
function nameUUIDFromBytes(input) {
  const hash = crypto.createHash('md5').update(Buffer.from(input, 'utf8')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.substr(0,8)}-${hex.substr(8,4)}-${hex.substr(12,4)}-${hex.substr(16,4)}-${hex.substr(20,12)}`;
}

/* ----- Presence helpers ----- */
function ensurePresenceServer(serverId) {
  if (!storePresence.has(serverId)) storePresence.set(serverId, new Map());
  return storePresence.get(serverId);
}
function touchPresence(serverId, uuid, ip) {
  const m = ensurePresenceServer(serverId);
  m.set(uuid, { ts: now(), ip: (ip || '') });
}
function unregisterPresence(serverId, uuid) {
  const m = storePresence.get(serverId);
  if (!m) return;
  m.delete(uuid);
}
function getActive(serverId) {
  const m = storePresence.get(serverId);
  if (!m) return [];
  const cutoff = now() - TTL_MS;
  const res = [];
  for (const [uuid, rec] of m.entries()) {
    if (!rec || typeof rec.ts !== 'number') { m.delete(uuid); continue; }
    if (rec.ts >= cutoff) res.push(uuid);
    else m.delete(uuid);
  }
  return res;
}

/* ----- Cosmetics helpers ----- */
function ensureCosmeticsServer(serverId) {
  if (!storeCosmetics.has(serverId)) storeCosmetics.set(serverId, new Map());
  return storeCosmetics.get(serverId);
}
function setCosmetics(serverId, key, cosmeticsArray) {
  const map = ensureCosmeticsServer(serverId);
  const cleaned = Array.from(new Set((Array.isArray(cosmeticsArray) ? cosmeticsArray : [])
    .map(s => String(s || '').trim().toLowerCase())
    .filter(s => s.length > 0))).slice(0, 32);
  map.set(key, cleaned);
}
function getCosmeticsMap(serverId) {
  const map = ensureCosmeticsServer(serverId);
  const out = {};
  for (const [k, arr] of map.entries()) out[k] = Array.from(arr);
  return out;
}
function deleteCosmetics(serverId, key) {
  const map = ensureCosmeticsServer(serverId);
  map.delete(key);
}
function addAlias(serverId, canonicalKey, aliasKey) {
  if (!canonicalKey || !aliasKey) return;
  const map = ensureCosmeticsServer(serverId);
  if (!map.has(canonicalKey)) map.set(canonicalKey, []);
  if (!map.has(aliasKey)) map.set(aliasKey, Array.from(map.get(canonicalKey)));
}
function migrateIfNeeded(serverId, oldKey, newKey) {
  if (!oldKey || !newKey) return false;
  const map = ensureCosmeticsServer(serverId);
  const old = map.get(oldKey);
  const cur = map.get(newKey);
  if (old && (!cur || cur.length === 0)) {
    map.set(newKey, Array.from(old));
    map.delete(oldKey);
    return true;
  }
  return false;
}

/* ----- Emote helpers ----- */
function ensureEmoteServer(serverId) {
  if (!storeEmotes.has(serverId)) storeEmotes.set(serverId, new Map());
  return storeEmotes.get(serverId);
}
function setEmote(serverId, uuid, emoteName) {
  const map = ensureEmoteServer(serverId);
  if (emoteName && typeof emoteName === 'string' && emoteName.trim().length > 0) {
    map.set(uuid, emoteName.trim());
  } else {
    map.delete(uuid);
  }
}
function getEmotesMap(serverId) {
  const map = storeEmotes.get(serverId);
  if (!map) return {};
  const out = {};
  for (const [uuid, emote] of map.entries()) out[uuid] = emote;
  return out;
}
function deleteEmote(serverId, uuid) {
  const map = storeEmotes.get(serverId);
  if (!map) return;
  map.delete(uuid);
}

/* ----- WebSocket subs and broadcast ----- */
const subs = new Map();
function broadcastToServerSubs(serverId, msg) {
  const set = subs.get(serverId);
  if (!set) return;
  const s = JSON.stringify(msg);
  for (const ws of set) {
    try { if (ws.readyState === WebSocket.OPEN) ws.send(s); } catch (e) {}
  }
  console.log(`[broadcast] server=${serverId} type=${msg.type} uuid=${msg.uuid || ''}`);
}

/* ================================================================
   ENDPOINTS
   ================================================================ */

app.get('/healthz', (req, res) => res.status(200).json({ ok: true, ts: now() }));

/* ----- Version Check ----- */

app.get('/version', (req, res) => {
  const playerName = req.query.player || 'unknown';
  console.log(`[version-check] player=${playerName}`);
  return res.json({ version: CLIENT_VERSION, update_content: UPDATE_CONTENT });
});

app.get('/download-url', (req, res) => {
  return res.json({ url: DOWNLOAD_URL, version: CLIENT_VERSION });
});

/* ----- Presence ----- */

// POST /register
app.post('/register', (req, res) => {
  const { server_id, uuid, oldKey, name } = req.body || {};
  if (!server_id || !uuid) return res.status(400).json({ error: 'missing server_id or uuid' });

  const rawIp = (req.ip || (req.connection && req.connection.remoteAddress) || '');
  const clientIp = String(rawIp).replace(/^::ffff:/, '');
  console.log(`[register] server=${server_id} uuid=${uuid} name=${name||''} oldKey=${oldKey||''} from=${clientIp}`);

  let migrated_from = null;

  if (oldKey) {
    if (migrateIfNeeded(server_id, oldKey, uuid)) {
      migrated_from = oldKey;
      console.log(`[register] migrated cosmetics ${oldKey} -> ${uuid} (oldKey provided)`);
    }
  }
  if (!migrated_from && name) {
    if (migrateIfNeeded(server_id, name, uuid)) {
      migrated_from = name;
      console.log(`[register] migrated cosmetics ${name} -> ${uuid} (name provided)`);
    }
  }
  if (name) {
    const offline = nameUUIDFromBytes('OfflinePlayer:' + name);
    try { addAlias(server_id, uuid, name); } catch (e) {}
    try { addAlias(server_id, uuid, offline); } catch (e) {}
  }

  touchPresence(server_id, uuid, clientIp);
  broadcastToServerSubs(server_id, { type: 'presence_add', uuid });

  return res.json({ ok: true, migrated_from });
});

// POST /unregister
app.post('/unregister', (req, res) => {
  const { server_id, uuid } = req.body || {};
  if (!server_id || !uuid) return res.status(400).json({ error: 'missing' });

  const rawIp = (req.ip || (req.connection && req.connection.remoteAddress) || '');
  const clientIp = String(rawIp).replace(/^::ffff:/, '');
  console.log(`[unregister] server=${server_id} uuid=${uuid} from=${clientIp}`);

  unregisterPresence(server_id, uuid);
  broadcastToServerSubs(server_id, { type: 'presence_remove', uuid });

  deleteCosmetics(server_id, uuid);
  broadcastToServerSubs(server_id, { type: 'cosmetics_remove', uuid });

  // Nettoyer l'emote active du joueur qui se deconnecte
  deleteEmote(server_id, uuid);
  broadcastToServerSubs(server_id, { type: 'emote_update', uuid, emote: null });

  return res.json({ ok: true });
});

// GET /servers/:serverId/neoclients
app.get('/servers/:serverId/neoclients', (req, res) => {
  const serverId = req.params.serverId;
  const list = getActive(serverId);
  return res.json({ server_id: serverId, neoclients: list, ts: now() });
});

/* ----- Cosmetics ----- */

// POST /servers/:serverId/cosmetics  (format tableau de noms)
app.post('/servers/:serverId/cosmetics', (req, res) => {
  const serverId = req.params.serverId;
  const { server_id, uuid, cosmetics, name } = req.body || {};
  if (!serverId || !uuid || !Array.isArray(cosmetics)) return res.status(400).json({ ok: false, error: 'invalid' });

  let cleaned = Array.from(new Set(cosmetics.map(String).map(s => s.trim().toLowerCase()).filter(Boolean))).slice(0, 32);

  const HAS_LEGACY_CAPE = cleaned.includes('cape');
  if (HAS_LEGACY_CAPE) {
    cleaned = cleaned.filter(c => c !== 'cape');
    const map = ensureCosmeticsServer(serverId);
    const existing = map.get(uuid);
    if (Array.isArray(existing) && existing.length > 0) {
      const specific = existing.filter(c => c && c.toLowerCase() !== 'cape');
      if (specific.length > 0) {
        cleaned = Array.from(new Set(specific.concat(cleaned))).slice(0, 32);
      }
    }
    if (cleaned.length === 0 && name) {
      const offline = nameUUIDFromBytes('OfflinePlayer:' + name);
      const candidateKeys = [name, offline];
      for (const k of candidateKeys) {
        const v = map.get(k);
        if (Array.isArray(v) && v.length > 0) {
          const specific = v.filter(c => c && c.toLowerCase() !== 'cape');
          if (specific.length > 0) {
            cleaned = Array.from(new Set(specific)).slice(0, 32);
            break;
          }
        }
      }
    }
    if (cleaned.length === 0) {
      cleaned = [DEFAULT_CAPE_ID];
    }
  }

  cleaned = Array.from(new Set(cleaned.map(s => String(s).trim().toLowerCase()).filter(Boolean))).slice(0, 32);
  setCosmetics(serverId, uuid, cleaned);

  if (name) {
    const offline = nameUUIDFromBytes('OfflinePlayer:' + name);
    try { addAlias(serverId, uuid, name); } catch (e) {}
    try { addAlias(serverId, uuid, offline); } catch (e) {}
  }

  console.log(`[cosmetics:set] server=${serverId} uuid=${uuid} cosmetics=${JSON.stringify(cleaned)} name=${name||''}`);
  broadcastToServerSubs(serverId, { type: 'cosmetics_set', uuid, cosmetics: cleaned });
  return res.json({ ok: true, cosmetics: cleaned });
});

// POST /cosmetics/update  (format type/ID numerique)
app.post('/cosmetics/update', (req, res) => {
  const { server_id, player, cosmetics } = req.body || {};
  if (!server_id || !player) return res.status(400).json({ error: 'Missing server_id or player' });

  console.log(`[cosmetics:update] server=${server_id} player=${player} cosmetics=${JSON.stringify(cosmetics)}`);

  const cosmeticNames = [];
  if (cosmetics && typeof cosmetics === 'object') {
    for (const [type, id] of Object.entries(cosmetics)) {
      const numericId = parseInt(id, 10);
      const name = ID_TO_NAME[numericId];
      if (name) {
        cosmeticNames.push(name);
        console.log(`[cosmetics:update] Converted type=${type} id=${numericId} -> ${name}`);
      } else {
        console.warn(`[cosmetics:update] Unknown cosmetic ID: ${numericId}`);
      }
    }
  }

  if (cosmeticNames.length > 0) {
    setCosmetics(server_id, player, cosmeticNames);
    broadcastToServerSubs(server_id, { type: 'cosmetics_set', uuid: player, cosmetics: cosmeticNames });
    console.log(`[cosmetics:update] Stored for ${player}: ${JSON.stringify(cosmeticNames)}`);
  } else {
    deleteCosmetics(server_id, player);
    broadcastToServerSubs(server_id, { type: 'cosmetics_remove', uuid: player });
    console.log(`[cosmetics:update] Cleared for ${player} (no valid cosmetics)`);
  }

  return res.json({ ok: true, player, cosmetics: cosmeticNames });
});

// POST /cosmetics/delete
app.post('/cosmetics/delete', (req, res) => {
  const { server_id, player } = req.body || {};
  if (!server_id || !player) return res.status(400).json({ error: 'Missing server_id or player' });

  console.log(`[cosmetics:delete] server=${server_id} player=${player}`);
  deleteCosmetics(server_id, player);
  broadcastToServerSubs(server_id, { type: 'cosmetics_remove', uuid: player });
  return res.json({ ok: true, player });
});

// GET /servers/:serverId/cosmetics
app.get('/servers/:serverId/cosmetics', (req, res) => {
  const serverId = req.params.serverId;
  const map = getCosmeticsMap(serverId);
  return res.json({ server_id: serverId, cosmetics: map, ts: now() });
});

/* ----- Emotes ----- */

/**
 * POST /servers/:serverId/emotes
 * Body: { server_id, uuid, emote: "Dab" | null }
 * - emote = string  -> joueur a lance cette emote
 * - emote = null    -> joueur a arrete son emote
 */
app.post('/servers/:serverId/emotes', (req, res) => {
  const serverId = req.params.serverId;
  const { uuid, emote } = req.body || {};

  if (!serverId || !uuid) {
    return res.status(400).json({ ok: false, error: 'missing server_id or uuid' });
  }

  const emoteName = (emote && typeof emote === 'string') ? emote.trim() : null;
  setEmote(serverId, uuid, emoteName);

  console.log(`[emotes:set] server=${serverId} uuid=${uuid} emote=${emoteName || 'null'}`);

  // Broadcast WebSocket aux abonnes
  broadcastToServerSubs(serverId, { type: 'emote_update', uuid, emote: emoteName });

  return res.json({ ok: true, uuid, emote: emoteName });
});

/**
 * GET /servers/:serverId/emotes
 * Retourne: { server_id, emotes: { "PlayerA": "Dab", "PlayerB": "Wave" }, ts }
 * Seuls les joueurs avec une emote active apparaissent dans la map.
 */
app.get('/servers/:serverId/emotes', (req, res) => {
  const serverId = req.params.serverId;
  const emotes = getEmotesMap(serverId);
  return res.json({ server_id: serverId, emotes, ts: now() });
});

/* ----- Admin ----- */

app.post('/admin/migrate-cape', (req, res) => {
  const secret = req.query.secret || '';
  if (!ADMIN_SECRET || secret !== ADMIN_SECRET) return res.status(403).json({ ok: false, error: 'forbidden' });
  const target = (req.body && req.body.target) ? String(req.body.target).trim().toLowerCase() : DEFAULT_CAPE_ID;
  let migrated = 0;
  for (const [sid, map] of storeCosmetics.entries()) {
    for (const [key, arr] of Array.from(map.entries())) {
      if (Array.isArray(arr) && arr.length === 1 && String(arr[0]).toLowerCase() === 'cape') {
        map.set(key, [target]);
        migrated++;
        console.log(`[admin:migrate] server=${sid} key=${key} migrated 'cape' -> '${target}'`);
      }
    }
  }
  return res.json({ ok: true, migrated, migrated_to: target });
});

/* ---------- WebSocket server ---------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  console.log(`[ws] connection from ${req.socket.remoteAddress || 'unknown'}`);

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data && data.action === 'subscribe' && data.server_id) {
        const sid = data.server_id;
        if (!subs.has(sid)) subs.set(sid, new Set());
        subs.get(sid).add(ws);
        console.log(`[ws] subscribe server=${sid} from ${req.socket.remoteAddress || 'unknown'}`);
        // Snapshot complet incluant cosmetics ET emotes
        ws.send(JSON.stringify({
          type: 'snapshot',
          neoclients: getActive(sid),
          cosmetics: getCosmeticsMap(sid),
          emotes: getEmotesMap(sid)
        }));
      }
    } catch (e) {
      console.warn('[ws] bad message:', raw && raw.toString ? raw.toString() : raw);
    }
  });

  ws.on('close', () => {
    for (const [sid, set] of subs.entries()) {
      set.delete(ws);
      if (set.size === 0) subs.delete(sid);
    }
    console.log('[ws] client disconnected');
  });
});

/* ---------- debug route ---------- */
app.get('/debug/store', (req, res) => {
  const presence = {};
  for (const [sid, map] of storePresence.entries()) {
    presence[sid] = {};
    for (const [uuid, rec] of map.entries()) presence[sid][uuid] = rec;
  }
  const cosmetics = {};
  for (const [sid, map] of storeCosmetics.entries()) {
    cosmetics[sid] = {};
    for (const [k, arr] of map.entries()) cosmetics[sid][k] = Array.from(arr);
  }
  const emotes = {};
  for (const [sid, map] of storeEmotes.entries()) {
    emotes[sid] = {};
    for (const [uuid, emote] of map.entries()) emotes[sid][uuid] = emote;
  }
  res.json({ now: now(), ttl_ms: TTL_MS, migrate_window_ms: MIGRATE_WINDOW_MS, presence, cosmetics, emotes });
});

/* ---------- error handlers & start ---------- */
process.on('uncaughtException', (err) => {
  console.error('uncaughtException, exiting:', err);
  setTimeout(() => process.exit(1), 100);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

server.listen(PORT, () => {
  console.log(`NeoClient API listening on port ${PORT} (env PORT=${process.env.PORT})`);
  console.log(`NODE_ENV=${process.env.NODE_ENV || 'undefined'} TTL_MS=${TTL_MS} MIGRATE_WINDOW_MS=${MIGRATE_WINDOW_MS}`);
  console.log(`Cosmetic mappings loaded: ${Object.keys(ID_TO_NAME).length} cosmetics`);
  console.log(`Current client version: ${CLIENT_VERSION}`);
  console.log(`Download URL: ${DOWNLOAD_URL}`);
});
