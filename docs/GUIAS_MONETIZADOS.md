# Guias monetizados no blog

O link que vai nos vídeos e nas DMs abre uma página do blog (`/blog/<guia>`), e o PDF vira um botão dentro dela. Os PDFs em `public/guias/*.pdf` não mudam e continuam abrindo pelo endereço antigo (`/guias/roma-em-3-dias.pdf`).

## Blocos novos do editor (`/admin-blog.html`)

| Bloco (`t`) | O que faz | Aparece em produção sem parceiro? |
|---|---|---|
| `pdf` | Botão "Baixar o guia (PDF)", download direto, grátis, sem cadastro. Se for o primeiro bloco do guia, sobe para o cabeçalho da página (visível sem rolar). `href` precisa ser `/guias/<nome>.pdf`. | sim |
| `passeio` | Botão de passeios no GetYourGuide (`busca` = termo de busca). Sem preço. | **não** |
| `whatsapp` | Abre o WhatsApp da Rota Certa com a mensagem pronta (padrão: cita o destino do guia). | sim |
| `carro` | Reserva de carro. Só colocar em destinos onde faz sentido. | **não** |
| `contato` | "Falar com a gente": Instagram Direct e e-mail. | sim |
| `afiliado` | Linha "Alguns links são de parceiros: podemos receber uma comissão, sem custo para você." | só se houver botão de parceiro ativo na página |

Cada botão leva `utm_source=rotacerta&utm_medium=blog&utm_campaign=<destino>&utm_content=<tipo>-<n>` (por exemplo `passeio-2`). O site não tem hoje um registro próprio de cliques, então a medição é pelos parâmetros (o formulário de proposta já guarda `utm_*`). Links de parceiro saem com `rel="sponsored noopener"`.

## Fotos nos guias

- Bloco `img` do editor (botão "Foto"): imagem, **descrição da foto** (alt, PT-BR, descreve o que aparece), **legenda** curta e **crédito** (ex.: `Foto: Nome do autor / Unsplash`). Com crédito, legenda e crédito saem em linhas próprias; sem crédito, a figura sai como sempre.
- Mobile primeiro: a foto ocupa a largura do texto, com cantos arredondados, `width`/`height` (sem pulo de layout) e `loading="lazy"`. A foto de capa (topo) carrega normal, com prioridade.
- Arquivos em `public/assets/blog/<nome>.jpg` (o editor só aceita esse endereço, plano). Padrão do guia de Roma: capa `roma-3-dias.jpg` (1100 px, vira também `og:image`), `roma-3-dias-m.jpg` (900 px, celular e cartão do índice) e `roma-3-dias-p.webp` (600 px); fotos do texto com 1000 px de largura e menos de 250 KB, nome `roma-<lugar>.jpg`. O `public/_headers` dá cache de 30 dias a `/assets/blog/*`: para trocar uma foto no ar, suba com outro nome.
- Use só fotos com licença livre registrada em `rota-certa-motion-factory/assets/licenses.csv` (autor e fonte). Fotos do Unsplash+ (pagas) não entram.
- O crédito da foto de capa vai numa linha no fim do texto ("Foto de capa: ..."), porque o post não tem campo de crédito da capa.
- Atualizar só o rascunho de um guia já criado: `npx tsx tools/gerar-migration-guia.ts content/guias/<guia>.json d1/migrations/00NN_....sql --atualizar-rascunho` (UPDATE com `WHERE slug = ... AND status = 'draft'`: guia já publicado e outros posts não são tocados).

## Onde configurar os parceiros

Um arquivo só: `worker/blog-parceiros.ts`.

- `getyourguide.partnerId`: o `partner_id` do GetYourGuide. Vazio = botões de passeio escondidos.
- `carro.url`: link de afiliado completo (https) do parceiro de carro. Vazio = botão de carro escondido.
- `contato`: WhatsApp (mesmo número do rodapé), Instagram Direct e e-mail.
- `GUIAS_CURTOS`: endereços curtos. `roma: 'roma-em-3-dias'` faz `rotacertapassagens.com/guia/roma` levar ao guia (302, mantendo `utm_*`).

Botão de parceiro sem link: some para o público. Na pré-visualização do painel (`/blog/preview/<id>`) e em `localhost` aparece tracejado, marcado "Inativo", sem link.

## Como publicar um guia novo

1. Escrever o conteúdo em `content/guias/<guia>.json` (campos do post + `body` com os blocos). Usar só fatos do `guide.json` do guia.
2. Gerar a migration (entra como **rascunho**): `npx tsx tools/gerar-migration-guia.ts content/guias/<guia>.json d1/migrations/00NN_blog_guia_<guia>.sql`.
3. Aplicar a migration (`pnpm d1:migrate:remote`), conferir a prévia no painel e clicar em Publicar.
4. Se quiser endereço curto, acrescentar em `GUIAS_CURTOS`.

### Artigos já publicados (opção `--publicado`)

Para artigos que o dono já aprovou e que devem ir ao ar junto com o deploy, o gerador aceita `--publicado`: o post entra com `status = 'published'` e `published_at` preenchido. Sem a opção, nada muda (continua rascunho). Aceita vários arquivos de conteúdo de uma vez; o último argumento é sempre a migration de saída, e o primeiro arquivo recebe a data mais recente (aparece primeiro no índice):

`npx tsx tools/gerar-migration-guia.ts content/guias/a.json content/guias/b.json d1/migrations/00NN_blog_....sql --publicado`

### Categoria "Dicas de viagem"

Artigos que não são de um destino (milhas, promoções, erros de compra, roteiro, checklist) usam a categoria `dicas-de-viagem` (migration `0036_blog_regiao_dicas_de_viagem.sql`). Ela só aparece no filtro de `/blog/` quando tem ao menos um artigo publicado. Os cinco artigos estão em `content/guias/` (`milhas-sem-misterio`, `promocao-e-real`, `erros-ao-comprar-passagem`, `modelo-de-roteiro`, `checklist-antes-de-viajar`) e cada um começa pelo botão do PDF `/guias/<mesmo-slug>.pdf`. Fotos: Pexels, com autor em `Foto: <autor> / Pexels`.

## Etapa 2 (futuro): gerar os guias a partir do `guide.json`

`rota-certa-motion-factory/guides/<cidade>/guide.json` já tem título, versão, data, fontes com data de conferência, palavra-chave e CTA de contato. Falta o roteiro estruturado (hoje está só no `guia.html`). Plano:

1. Acrescentar ao `guide.json` uma lista `dias[]` (título, região, paradas com horário, preço e fonte, link de rota) e `passeios[]` (termo de busca por dia).
2. Um script no molde de `tools/gerar-migration-guia.ts` monta o `content/guias/<guia>.json` a partir do `guide.json`: bloco `pdf` no topo, `whatsapp` antes do roteiro, um `passeio` ao fim de cada dia, "Fontes oficiais" com os links de `sources[]`, `whatsapp` + `contato` + `afiliado` no fim.
3. Mesmo gerador de migration e mesmo painel: nada de código novo no site por destino.
4. `carro` só entra por decisão editorial (destinos de estrada: Orlando, Punta Cana, Cusco).
