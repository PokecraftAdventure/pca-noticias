# pca-noticias

Bot de noticias de Pokecraft Adventure. Lee los canales de noticias del servidor de Discord (solo lectura) y genera `news.json`, que el launcher descarga para mostrar las noticias.

## Como funciona
- `tools/news-bot.js` hace solo peticiones GET a la API de Discord. Nunca escribe mensajes ni cambia nada en el servidor.
- `tools/news-sources.json` lista los canales (solo IDs publicos) y su tipo: `store`, `announcement`, `event`, `tiktok`.
- `.github/workflows/news.yml` lo ejecuta cada 30 minutos y guarda `news.json` si cambio.
- Una noticia es destacada (`featured`) si es de la tienda o si el staff fija el mensaje en Discord.

## Token
El token del bot vive solo en el secreto `DISCORD_BOT_TOKEN` de GitHub Actions. Nunca va en el repositorio.

Para probar en local: `DISCORD_BOT_TOKEN=... node tools/news-bot.js news.json`
