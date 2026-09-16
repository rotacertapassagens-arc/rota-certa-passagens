# Snapshot do site publicado — rotacertapassagens.com

- **Data/hora do snapshot (UTC):** 2026-09-16T20:57:08Z
- **Data/hora do snapshot (local, America/Sao_Paulo, aproximado):** 2026-09-16 17:57
- **Comando usado:** `curl -s https://rotacertapassagens.com -o site-atual.html`
- **Arquivo:** `site-atual.html`
- **Tamanho:** 343076 bytes
- **SHA-256:** `1579086d9fba2c09afc55e4ee4fd6eef1ace64e861027d20e7b40583d9e2a5e5`

## Verificação de assets externos

O HTML foi inspecionado (`grep` por `src=`/`href=`) antes deste backup ser
considerado completo:

- Todas as imagens (~5 ocorrências de `data:` URI) estão embutidas como
  Base64 diretamente no HTML — nenhum arquivo de imagem separado para baixar.
- Não há CSS ou JS hospedados externamente que pertençam ao site (tudo está
  inline no próprio `site-atual.html`).
- Única dependência externa de fato: **Google Fonts**
  (`https://fonts.googleapis.com/css2?family=Playfair+Display:...&family=Montserrat:...`)
  — é um serviço de terceiros carregado ao vivo pelo navegador do visitante,
  não um asset do próprio site, então não foi baixado como parte deste backup.
- Demais links externos encontrados são apenas destinos de navegação
  (não assets): WhatsApp (`https://wa.me/351925307391`), Instagram, política
  de privacidade no Notion, e `mailto:rotacertapassagens@gmail.com`.

**Conclusão:** `site-atual.html` sozinho é uma cópia funcionalmente completa
do HTML publicado nesta data/hora. Nenhum outro arquivo precisou ser baixado.

## Evidência fresca confirmando o estado do site (coletada no momento deste snapshot)

- `curl -sI https://rotacertapassagens.com` → `HTTP/1.1 200 OK`, `Server: cloudflare`.
- `https://www.rotacertapassagens.com` → sem resposta (subdomínio `www` não configurado).
- DNS (via `Resolve-DnsName`):
  - `A`: 172.67.144.234, 104.21.10.76 (Cloudflare)
  - `AAAA`: 2606:4700:3030::ac43:90ea, 2606:4700:3035::6815:a4c (Cloudflare)
  - `MX`: nenhum registro (consulta retorna apenas o SOA da zona)
  - `TXT` no root (SPF): nenhum registro
  - `_dmarc.rotacertapassagens.com` `TXT` (DMARC): nenhum registro
  - `default._domainkey.rotacertapassagens.com` `TXT` (DKIM): nenhum registro
- Endpoints `/api/*` referenciados no JS do site, todos retornando `404`:
  - `GET /api/geo` → 404
  - `POST /api/lead` → 404
  - `POST /api/send-code` → 404
  - `POST /api/verify-code` → 404

Tudo consistente com a auditoria anterior — **nenhuma mudança detectada** no
site publicado, DNS, ou nos endpoints de API.
