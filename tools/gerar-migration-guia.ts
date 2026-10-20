// Gera a migration D1 de um guia do blog a partir de um arquivo de conteúdo (content/guias/<guia>.json).
//
//   npx tsx tools/gerar-migration-guia.ts content/guias/roma-em-3-dias.json d1/migrations/0024_blog_guia_roma_3_dias.sql
//   npx tsx tools/gerar-migration-guia.ts content/guias/roma-em-3-dias.json d1/migrations/0025_blog_roma_fotos.sql --atualizar-rascunho
//
// Com --atualizar-rascunho gera um UPDATE (capa, texto alternativo da capa, blocos e tempo de leitura) só do post com esse slug
// que ainda esteja como RASCUNHO. Post publicado ou outro post nunca é tocado.
//
// O guia entra como RASCUNHO (nada vai ao ar sozinho): quem publica é o painel (/admin-blog.html).
// Valida os blocos com as mesmas regras do editor e recusa travessão nos textos.
// Etapa 2 (futuro): outro script, no mesmo molde, monta esse JSON a partir de guides/<cidade>/guide.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { blocks, readingMinutes, slugify } from '../worker/blog.ts';

type Conteudo = {
  id: string; slug: string; regionId: string; title: string; titleHighlight: string | null; summary: string; lede: string | null;
  destination: string | null; coverUrl: string; coverUrlSmall: string | null; coverAlt: string | null; body: unknown;
  /** Opcional: região nova (id em regionId). Gera INSERT OR IGNORE em blog_regions antes do post; sem isso, a região precisa já existir. */
  regionName?: string; regionOrder?: number;
};

const args = process.argv.slice(2);
const atualizar = args.includes('--atualizar-rascunho');
const [entrada, saida] = args.filter((a) => !a.startsWith('--'));
if (!entrada || !saida) { console.error('Uso: tsx tools/gerar-migration-guia.ts <conteudo.json> <saida.sql> [--atualizar-rascunho]'); process.exit(2); }

const c = JSON.parse(readFileSync(entrada, 'utf8')) as Conteudo;
const body = blocks(c.body);
if (!body) { console.error('Algum bloco do conteúdo é inválido (confira tipos, tamanhos e o endereço do PDF).'); process.exit(1); }
if (slugify(c.slug) !== c.slug) { console.error(`Slug inválido: ${c.slug}`); process.exit(1); }
if (c.titleHighlight && !c.title.includes(c.titleHighlight)) { console.error('titleHighlight precisa ser um trecho do título.'); process.exit(1); }
const json = JSON.stringify(body);
if (/—|--/.test(`${c.title} ${c.summary} ${c.lede ?? ''} ${json}`)) { console.error('Travessão (— ou --) não é permitido nos textos.'); process.exit(1); }

const q = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
const minutos = readingMinutes(c, body);
const regiao = c.regionName
  ? `INSERT OR IGNORE INTO blog_regions (id, name, sort_order) VALUES (${q(c.regionId)}, ${q(c.regionName)}, ${Number.isInteger(c.regionOrder) ? c.regionOrder : 99});
`
  : '';
const sqlNovo = `-- Guia "${c.title}" (rascunho). Gerado por tools/gerar-migration-guia.ts a partir de ${entrada.replace(/\\/g, '/')}.
-- Entra como rascunho: publique pelo painel (/admin-blog.html) depois de conferir a pré-visualização.
${regiao}INSERT INTO blog_posts (id, slug, status, region_id, title, title_highlight, summary, lede, destination, cta_title, cover_url, cover_url_small, cover_alt, featured, body, reading_minutes)
VALUES (${q(c.id)}, ${q(c.slug)}, 'draft', ${q(c.regionId)}, ${q(c.title)}, ${q(c.titleHighlight)}, ${q(c.summary)}, ${q(c.lede)}, ${q(c.destination)}, NULL, ${q(c.coverUrl)}, ${q(c.coverUrlSmall)}, ${q(c.coverAlt)}, 0, ${q(json)}, ${minutos});
`;
const sqlAtualiza = `-- Atualiza SOMENTE o rascunho do guia "${c.title}" (slug ${c.slug}). Gerado por tools/gerar-migration-guia.ts a partir de ${entrada.replace(/\\/g, '/')}.
-- Se o post já tiver sido publicado, ou não existir, nada muda (WHERE slug e status = 'draft'). Nenhum outro post é tocado.
UPDATE blog_posts SET cover_url = ${q(c.coverUrl)}, cover_url_small = ${q(c.coverUrlSmall)}, cover_alt = ${q(c.coverAlt)}, body = ${q(json)}, reading_minutes = ${minutos}, updated_at = CURRENT_TIMESTAMP
WHERE slug = ${q(c.slug)} AND status = 'draft';
`;
writeFileSync(saida, atualizar ? sqlAtualiza : sqlNovo, 'utf8');
console.log(`ok: ${saida} (${atualizar ? 'UPDATE do rascunho' : 'INSERT'}, ${body.length} blocos, ${minutos} min de leitura)`);
