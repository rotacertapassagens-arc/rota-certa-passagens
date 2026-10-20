// Configuração dos guias monetizados do blog. É o ÚNICO lugar para preencher links e IDs de parceiros.
//
// Regra: botão de parceiro (passeio, carro) sem link configurado NÃO aparece no site publicado.
// Na pré-visualização do painel (/blog/preview/<id>) e no ambiente local ele aparece marcado como
// "Inativo", só para você ver o desenho. Preencheu, fez o deploy: o botão passa a aparecer para todos.

import type { BlogParceiros } from '../shared/blogGuias.js';

/**
 * - getyourguide.partnerId: seu partner_id do GetYourGuide. baseUrl: domínio dos links (confirme no painel de parceiros).
 * - carro.url: link de afiliado completo do parceiro de carro (https).
 * - contato: número de WhatsApp (o mesmo do rodapé e dos outros CTAs do site), Instagram Direct e e-mail.
 */
export const BLOG_PARCEIROS: BlogParceiros = {
  getyourguide: { partnerId: '', baseUrl: 'https://www.getyourguide.com.br' },
  carro: { url: '' },
  contato: {
    whatsapp: '351925307391',
    instagramDm: 'https://ig.me/m/rotacerta.passagens',
    email: 'contato@rotacertapassagens.com',
  },
};

/**
 * Endereços curtos para falar em vídeo e digitar no celular: rotacertapassagens.com/guia/roma
 * leva ao guia do blog (e repassa utm_* se houver). Chave = trecho curto; valor = slug do guia no blog.
 * Um destino novo entra aqui junto com o guia publicado. Não pode repetir rota existente do site.
 */
export const GUIAS_CURTOS: Record<string, string> = {
  roma: 'roma-em-3-dias',
  madri: 'madri-em-4-dias',
};
