// Gera a migration D1 de um guia do blog a partir de um arquivo de conteúdo (content/guias/<guia>.json).
//
//   npx tsx tools/gerar-migration-guia.ts content/guias/roma-em-3-dias.json d1/migrations/0024_blog_guia_roma_3_dias.sql
//
// O guia entra como RASCUNHO (nada vai ao ar sozinho): quem publica é o painel (/admin-blog.html).
// Valida os blocos com as mesmas regras do editor e recusa travessão nos textos.
// Etapa 2 (futuro): outro script, no mesmo molde, monta esse JSON a partir de guides/<cidade>/guide.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { blocks, readingMinutes, slugify } from '../worker/blog.ts';

type Conteudo = {
  id: string; slug: string; regionId: string; title: string; titleHighlight: string | null; summary: string; lede: string | null;
  destination: string | null; coverUrl: string; coverUrlSmall: string | null; coverAlt: string | null; body: unknown;
};

const [entrada, saida] = process.argv.slice(2);
if (!entrada || !saida) { console.error('Uso: tsx tools/gerar-migration-guia.ts <conteudo.json> <saida.sql>'); process.exit(2); }

const c = JSON.parse(readFileSync(entrada, 'utf8')) as Conteudo;
const body = blocks(c.body);
if (!body) { console.error('Algum bloco do conteúdo é inválido (confira tipos, tamanhos e o endereço do PDF).'); process.exit(1); }
if (slugify(c.slug) !== c.slug) { console.error(`Slug inválido: ${c.slug}`); process.exit(1); }
if (c.titleHighlight && !c.title.includes(c.titleHighlight)) { console.error('titleHighlight precisa ser um trecho do título.'); process.exit(1); }
const json = JSON.stringify(body);
if (/—|--/.test(`${c.title} ${c.summary} ${c.lede ?? ''} ${json}`)) { console.error('Travessão (— ou --) não é permitido nos textos.'); process.exit(1); }

const q = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
const sql = `-- Guia "${c.title}" (rascunho). Gerado por tools/gerar-migration-guia.ts a partir de ${entrada.replace(/\\/g, '/')}.
-- Entra como rascunho: publique pelo painel (/admin-blog.html) depois de conferir a pré-visualização.
INSERT INTO blog_posts (id, slug, status, region_id, title, title_highlight, summary, lede, destination, cta_title, cover_url, cover_url_small, cover_alt, featured, body, reading_minutes)
VALUES (${q(c.id)}, ${q(c.slug)}, 'draft', ${q(c.regionId)}, ${q(c.title)}, ${q(c.titleHighlight)}, ${q(c.summary)}, ${q(c.lede)}, ${q(c.destination)}, NULL, ${q(c.coverUrl)}, ${q(c.coverUrlSmall)}, ${q(c.coverAlt)}, 0, ${q(json)}, ${readingMinutes(c, body)});
`;
writeFileSync(saida, sql, 'utf8');
console.log(`ok: ${saida} (${body.length} blocos, ${readingMinutes(c, body)} min de leitura)`);
