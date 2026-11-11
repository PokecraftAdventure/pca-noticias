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

function toItem(msg, type) {
    const text = String(msg.content || '').trim();
    const embed = (msg.embeds || [])[0] || {};
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

async function main() {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) throw new Error('Falta DISCORD_BOT_TOKEN (secreto de GitHub)');
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'news-sources.json'), 'utf8'));
    const out = path.resolve(process.argv[2] || 'news.json');
    const items = [];
    for (const s of cfg.sources.filter(x => x.channelId)) {
        const msgs = await readChannel(token, s.channelId, cfg.limitPerChannel || 10);
        for (const m of msgs) { const it = toItem(m, s.type); if (it) items.push(it); }
    }
    items.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    // Si ninguna fuente esta configurada no se pisa un news.json existente.
    if (!cfg.sources.some(x => x.channelId)) { console.log('Sin canales configurados: no se escribe nada.'); return; }
    fs.writeFileSync(out, JSON.stringify({ items }, null, 2) + '\n');
    console.log(`${items.length} noticias escritas en ${out}`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { toItem };
