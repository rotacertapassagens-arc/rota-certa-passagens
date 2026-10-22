// Gera a migration D1 de um guia do blog a partir de um arquivo de conteúdo (content/guias/<guia>.json).
//
//   npx tsx tools/gerar-migration-guia.ts content/guias/roma-em-3-dias.json d1/migrations/0024_blog_guia_roma_3_dias.sql
//   npx tsx tools/gerar-migration-guia.ts content/guias/roma-em-3-dias.json d1/migrations/0025_blog_roma_fotos.sql --atualizar-rascunho
//   npx tsx tools/gerar-migration-guia.ts content/guias/a.json content/guias/b.json d1/migrations/00NN_blog_....sql --publicado
//
// Com --atualizar-rascunho gera um UPDATE (capa, texto alternativo da capa, blocos e tempo de leitura) só do post com esse slug
// que ainda esteja como RASCUNHO. Post publicado ou outro post nunca é tocado.
//
// Por padrão o guia entra como RASCUNHO (nada vai ao ar sozinho): quem publica é o painel (/admin-blog.html).
// Com --publicado (opção explícita) o guia entra já PUBLICADO, com published_at preenchido. Aceita vários arquivos de conteúdo
// (o último argumento é sempre a migration de saída); o primeiro arquivo recebe a data mais recente, para aparecer primeiro no índice.
// Valida os blocos com as mesmas regras do editor e recusa travessão nos textos.
// Etapa 2 (futuro): outro script, no mesmo molde, monta esse JSON a partir de guides/<cidade>/guide.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { blocks, readingMinutes, slugify } from '../worker/blog.ts';

type Conteudo = {
  id: string; slug: string; regionId: string; title: string; titleHighlight: string | null; summary: string; lede: string | null;
  destination: string | null; coverUrl: string; coverUrlSmall: string | null; coverAlt: string | null; body: unknown;
};

const args = process.argv.slice(2);
const atualizar = args.includes('--atualizar-rascunho');
const publicado = args.includes('--publicado');
const posicionais = args.filter((a) => !a.startsWith('--'));
const saida = posicionais.at(-1);
const entradas = posicionais.slice(0, -1);
if (!entradas.length || !saida || !saida.endsWith('.sql')) {
  console.error('Uso: tsx tools/gerar-migration-guia.ts <conteudo.json> [<conteudo2.json> ...] <saida.sql> [--atualizar-rascunho | --publicado]');
  process.exit(2);
}
if (atualizar && publicado) { console.error('Use --atualizar-rascunho ou --publicado, não os dois.'); process.exit(2); }

const q = (v: string | null) => (v === null ? 'NULL' : `'${v.replace(/'/g, "''")}'`);
const IMAGEM = /^\/assets\/blog\/[a-z0-9-]+\.(jpg|jpeg|png|webp)$/;
const falha = (entrada: string, msg: string): never => { console.error(`${entrada}: ${msg}`); process.exit(1); };

const partes: string[] = [];
let resumo = '';
entradas.forEach((entrada, i) => {
  const c = JSON.parse(readFileSync(entrada, 'utf8')) as Conteudo;
  const body = blocks(c.body);
  if (!body) return falha(entrada, 'Algum bloco do conteúdo é inválido (confira tipos, tamanhos e o endereço do PDF).');
  if (slugify(c.slug) !== c.slug) return falha(entrada, `Slug inválido: ${c.slug}`);
  if (c.titleHighlight && !c.title.includes(c.titleHighlight)) return falha(entrada, 'titleHighlight precisa ser um trecho do título.');
  // Mesmos limites do editor (parsePost em worker/blog.ts), para o painel conseguir salvar o guia depois.
  if (c.title.length < 3 || c.title.length > 140) return falha(entrada, 'O título precisa ter de 3 a 140 caracteres.');
  if (c.summary.length < 10 || c.summary.length > 300) return falha(entrada, 'O resumo precisa ter de 10 a 300 caracteres.');
  if ((c.lede ?? '').length > 300) return falha(entrada, 'A frase de abertura (lede) passa de 300 caracteres.');
  if ((c.coverAlt ?? '').length > 200) return falha(entrada, 'O texto alternativo da capa passa de 200 caracteres.');
  if (!IMAGEM.test(c.coverUrl) || (c.coverUrlSmall && !IMAGEM.test(c.coverUrlSmall))) return falha(entrada, 'Capa fora do padrão /assets/blog/<nome>.jpg.');
  const json = JSON.stringify(body);
  if (/—|--/.test(`${c.title} ${c.summary} ${c.lede ?? ''} ${json}`)) return falha(entrada, 'Travessão (— ou --) não é permitido nos textos.');
  const minutos = readingMinutes(c, body);
  const origem = entrada.replace(/\\/g, '/');
  if (atualizar) {
    partes.push(`-- Atualiza SOMENTE o rascunho do guia "${c.title}" (slug ${c.slug}). Gerado por tools/gerar-migration-guia.ts a partir de ${origem}.
-- Se o post já tiver sido publicado, ou não existir, nada muda (WHERE slug e status = 'draft'). Nenhum outro post é tocado.
UPDATE blog_posts SET cover_url = ${q(c.coverUrl)}, cover_url_small = ${q(c.coverUrlSmall)}, cover_alt = ${q(c.coverAlt)}, body = ${q(json)}, reading_minutes = ${minutos}, updated_at = CURRENT_TIMESTAMP
WHERE slug = ${q(c.slug)} AND status = 'draft';
`);
  } else {
    const estado = publicado ? 'PUBLICADO' : 'rascunho';
    const status = publicado ? "'published'" : "'draft'";
    const quando = publicado ? `, published_at` : '';
    // Datas escalonadas de 1 minuto: o primeiro arquivo fica como o mais recente.
    const valorQuando = publicado ? `, datetime('now', '-${i} minutes')` : '';
    partes.push(`-- Guia "${c.title}" (${estado}). Gerado por tools/gerar-migration-guia.ts a partir de ${origem}.
${publicado ? '-- Entra já publicado (--publicado): aparece em /blog/ assim que a migration for aplicada.' : "-- Entra como rascunho: publique pelo painel (/admin-blog.html) depois de conferir a pré-visualização."}
INSERT INTO blog_posts (id, slug, status, region_id, title, title_highlight, summary, lede, destination, cta_title, cover_url, cover_url_small, cover_alt, featured, body, reading_minutes${quando})
VALUES (${q(c.id)}, ${q(c.slug)}, ${status}, ${q(c.regionId)}, ${q(c.title)}, ${q(c.titleHighlight)}, ${q(c.summary)}, ${q(c.lede)}, ${q(c.destination)}, NULL, ${q(c.coverUrl)}, ${q(c.coverUrlSmall)}, ${q(c.coverAlt)}, 0, ${q(json)}, ${minutos}${valorQuando});
`);
  }
  resumo += `\n  ${c.slug}: ${body.length} blocos, ${minutos} min de leitura`;
});
writeFileSync(saida, partes.join('\n'), 'utf8');
console.log(`ok: ${saida} (${atualizar ? 'UPDATE do rascunho' : publicado ? 'INSERT publicado' : 'INSERT rascunho'}, ${entradas.length} guia(s))${resumo}`);
