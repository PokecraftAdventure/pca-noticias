/**
 * Pokecraft Adventure Launcher
 * Genera news.json a partir de canales de Discord. SOLO LECTURA: unicamente hace GET a la API de
 * Discord y nunca escribe mensajes ni cambia nada en el servidor.
 *
 * Uso (lo ejecuta el flujo de GitHub Actions .github/workflows/news.yml):
 *   DISCORD_BOT_TOKEN=... node tools/news-bot.js [salida=news.json]
 *
 * El token SOLO se lee de la variable de entorno (secreto de GitHub). No se guarda en el repositorio.
 * Los canales y su tipo (announcement | store | event | tiktok) estan en tools/news-sources.json.
 * Formato de cada noticia: { id, type, title, body, image, author, date, url, featured }.
 * Nota: los enlaces de imagenes adjuntas de Discord caducan; si se quieren permanentes, publicar la
 * imagen en el repositorio o usar un enlace externo en el mensaje.
 */
const fs = require('fs');
const path = require('path');

const API = 'https://discord.com/api/v10';
const MAX_BODY = 600;

// Quita menciones de Discord sin resolver (<@123>, <@&123>, <#123>, @everyone, @here) y espacios sobrantes.
const clean = s => String(s || '').replace(/<@[&!]?\d+>|<#\d+>|@(everyone|here)\b/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

function toItem(msg, type) {
    const text = clean(msg.content);
    const embed = ((msg.embeds || [])[0]) ? { ...msg.embeds[0], title: clean(msg.embeds[0].title), description: clean(msg.embeds[0].description) } : {};
    const att = (msg.attachments || []).find(a => /^image\//.test(a.content_type || '')) || null;
    const lines = text.split('\n').filter(Boolean);
    const title = (embed.title || (lines[0] || '')).replace(/^[#*\s]+|[*\s]+$/g, '').slice(0, 120);
    const bodyRaw = embed.description || (lines.length > 1 ? lines.slice(1).join('\n') : (embed.title ? text : ''));
    const url = embed.url || ((text.match(/https?:\/\/\S+/) || [])[0] || '');
    if (!title && !bodyRaw && !att) return null;
    return {
        id: String(msg.id),
        type,
        title,
        body: bodyRaw.slice(0, MAX_BODY),
        image: (att && att.url) || (embed.image && embed.image.url) || (embed.thumbnail && embed.thumbnail.url) || '',
        author: (msg.author && (msg.author.global_name || msg.author.username)) || '',
        date: msg.timestamp || '',
        url,
        // Destacada: siempre la tienda, o cualquier mensaje que el staff fije (pin) en Discord.
        featured: type === 'store' || msg.pinned === true
    };
}

async function readChannel(token, channelId, limit) {
    const res = await fetch(`${API}/channels/${channelId}/messages?limit=${limit}`, {
        headers: { Authorization: `Bot ${token}`, 'User-Agent': 'PokecraftAdventure-NewsBot' }
    });
    if (!res.ok) throw new Error(`Discord ${res.status} en el canal ${channelId}`);
    return res.json();
}

const MAX_IMG = 8 * 1024 * 1024;
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* opcional: sin sharp se guarda la imagen original */ }

/**
 * Los enlaces de imagenes de Discord y de TikTok llevan una firma que caduca. Se copian al repositorio
 * (carpeta images/, nombre = id del mensaje) y la noticia apunta a la copia, que no caduca.
 * Con sharp (se instala en el flujo) se reducen a 1280 px de ancho y webp; los gif se dejan tal cual.
 * Si una descarga falla, la noticia conserva el enlace original (recien generado, aun vigente).
 */
async function mirrorImages(items, base, dir, prune) {
    if (!base) return;
    fs.mkdirSync(dir, { recursive: true });
    const keep = new Set();
    for (const it of items) {
        if (!/^https?:\/\//i.test(it.image || '')) continue;
        let file = fs.readdirSync(dir).find(f => f.startsWith(it.id + '.'));
        if (!file) {
            try {
                const res = await fetch(it.image, { headers: { 'User-Agent': 'PokecraftAdventure-NewsBot' } });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                let buf = Buffer.from(await res.arrayBuffer());
                if (buf.length > MAX_IMG) throw new Error('imagen demasiado grande');
                let ext = EXT[(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()];
                if (!ext) throw new Error('tipo de imagen no soportado');
                if (sharp && ext !== '.gif') {
                    buf = await sharp(buf).rotate().resize({ width: 1280, withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
                    ext = '.webp';
                }
                file = it.id + ext;
                fs.writeFileSync(path.join(dir, file), buf);
            } catch (e) { console.error(`Aviso: imagen de ${it.id}: ${e.message}`); continue; }
        }
        keep.add(file);
        it.image = `${base}/${file}`;
    }
    // Borra las imagenes de noticias que ya no estan (solo si se leyeron todos los canales).
    if (prune) for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.unlinkSync(path.join(dir, f));
}

async function main() {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) throw new Error('Falta DISCORD_BOT_TOKEN (secreto de GitHub)');
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'news-sources.json'), 'utf8'));
    const out = path.resolve(process.argv[2] || 'news.json');
    const items = [];
    const failed = [];
    for (const s of cfg.sources.filter(x => x.channelId)) {
        // Un canal que falla (p. ej. 403 por falta de permiso) no tumba a los demas.
        try {
            const msgs = await readChannel(token, s.channelId, cfg.limitPerChannel || 10);
            for (const m of msgs) { const it = toItem(m, s.type); if (it) items.push(it); }
        } catch (e) { failed.push(s.channelId); console.error(`Aviso: ${e.message}`); }
    }
    const total = cfg.sources.filter(x => x.channelId).length;
    // Si fallaron todos no se pisa el news.json existente.
    if (total && failed.length === total) throw new Error('No se pudo leer ningun canal');
    items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    // Si ninguna fuente esta configurada no se pisa un news.json existente.
    if (!cfg.sources.some(x => x.channelId)) { console.log('Sin canales configurados: no se escribe nada.'); return; }
    await mirrorImages(items, cfg.imageBase, path.join(path.dirname(out), 'images'), failed.length === 0);
    fs.writeFileSync(out, JSON.stringify({ items }, null, 2) + '\n');
    console.log(`${items.length} noticias escritas en ${out}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { toItem, mirrorImages };
