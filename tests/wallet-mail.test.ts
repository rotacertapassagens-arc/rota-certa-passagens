import { describe, expect, it } from 'vitest';
import { parseMiles, parseMoneyCents, parseWalletMail } from '../shared/walletMail.js';

// Trechos reais (sem links) dos e-mails que os programas mandaram em outubro de 2026.
const livelo = {
  id: 'm-livelo', from: 'livelo@mail.infolivelo.com.br', date: '2026-10-24T02:18:09Z',
  subject: 'Oba! Seus pontos Livelo chegaram, aproveite! 😎',
  text: 'Saldo em 22/10/2026 7.230 pts Clube Livelo Oba, seus pontos do Clube Livelo já chegaram na sua conta! Oba, Carlos, seus pontos chegaram! Os 1.000 pontos do seu Clube Classic já estão disponíveis na sua conta. [ Clube Classic ] Pontos creditados:1.000 Total de pontos:8.230 Início da assinatura:23/02/2026 Valor mensal:R$ 44,90',
};
const smilesFalha = {
  id: 'm-smiles', from: 'transacional@comunicado.smiles.com.br', date: '2026-10-26T05:46:31Z',
  subject: 'Mateus, o pagamento do seu Clube Smiles não foi concluído.',
  text: 'Olá, Mateus 👋 Categoria Smiles Número Smiles 186196592 Saldo de milhas 33,500 Houve um imprevisto com o pagamento do seu Clube Smiles, Mateus. Veja os detalhes do seu plano Clube Smiles 1.000: Nome completo MATEUS SILVA MATOS Primeira recorrência 31/03/2026 Forma de pagamento Mensal Valor do plano R$46,00',
};
const esferaOk = {
  id: 'm-esfera-ok', from: 'no-reply@info.esfera.com.vc', date: '2026-10-24T11:30:12Z',
  subject: 'Ótima notícia: sua mensalidade foi aprovada.',
  text: 'Pronto! Seu pagamento foi aprovado Olá, CARLOS! Recebemos o pagamento da sua assinatura do Clube Esfera. Seus pontos já constam em seu saldo.',
};
const esferaFalha = {
  id: 'm-esfera-falha', from: 'no-reply@info.esfera.com.vc', date: '2026-10-25T12:00:24Z',
  subject: 'Clube: Seu pagamento não foi realizado.',
  text: 'Pagamento não foi realizado Olá, CARLOS! O pagamento da sua assinatura do Clube Esfera não foi realizado. Confira se há algum problema com o cartão cadastrado.',
};
const latamCancelado = {
  id: 'm-latam-cancel', from: 'info@latampassmail.com', date: '2026-10-10T09:05:32Z',
  subject: 'Poxa! Sua assinatura do Clube LATAM Pass foi cancelada!',
  text: 'CARLOS VICTOR, você tem 10000 milhas Ver Extrato Olá, CARLOS VICTOR Infelizmente não conseguimos renovar a assinatura do seu Clube LATAM Pass por problemas no pagamento. Data de Cancelamento: 10/10/2026 Plano: LATAM Pass + Turbo Valor do Plano: 356,80 Milhas Mensais: 10000',
};
const latamFalha = {
  id: 'm-latam-falha', from: 'info@latampassmail.com', date: '2026-10-24T07:53:13Z',
  subject: 'Não identificamos pagamento do seu Clube LATAM Pass.',
  text: 'Atualize já suas informações de pagamento. MATEUS, você tem 10000 milhas Ver Extrato Olá, MATEUS Houve uma falha na validação do seu cartão de crédito e, por isso, seu pagamento da mensalidade do Clube LATAM Pass.',
};

describe('leitor dos e-mails dos programas', () => {
  it('Livelo: pontos do clube chegaram, com o total e o valor da mensalidade', () => {
    expect(parseWalletMail(livelo)).toMatchObject({ kind: 'club_credited', program: 'Livelo', holderHint: 'Carlos', miles: 1000, balance: 8230, planName: 'Clube Classic', monthlyCostCents: 4490 });
  });
  it('Smiles: pagamento do clube recusado, com número do sócio e saldo', () => {
    expect(parseWalletMail(smilesFalha)).toMatchObject({ kind: 'club_payment_failed', program: 'Smiles', holderHint: 'Mateus', memberNumber: '186196592', balance: 33500, monthlyCostCents: 4600 });
  });
  it('Esfera: mensalidade aprovada e pagamento não realizado são eventos diferentes', () => {
    expect(parseWalletMail(esferaOk)).toMatchObject({ kind: 'club_payment_ok', program: 'Esfera', holderHint: 'Carlos' });
    expect(parseWalletMail(esferaFalha)).toMatchObject({ kind: 'club_payment_failed', program: 'Esfera' });
  });
  it('Esfera: "pode ser cancelado em breve" é aviso de pagamento, não cancelamento', () => {
    const aviso = { id: 'm-esfera-aviso', from: 'no-reply@info.esfera.com.vc', date: '2026-10-18T06:00:12Z', subject: 'Clube: Seu plano pode ser cancelado em breve.', text: 'Seu Clube Esfera pode ser cancelado em breve Olá, CARLOS! O pagamento da sua assinatura do Clube Esfera não foi realizado.' };
    expect(parseWalletMail(aviso)).toMatchObject({ kind: 'club_payment_failed', program: 'Esfera' });
  });
  it('LATAM Pass: clube cancelado e pagamento não identificado', () => {
    expect(parseWalletMail(latamCancelado)).toMatchObject({ kind: 'club_canceled', program: 'LATAM Pass', holderHint: 'Carlos', balance: 10000, miles: 10000, monthlyCostCents: 35680 });
    expect(parseWalletMail(latamFalha)).toMatchObject({ kind: 'club_payment_failed', holderHint: 'Mateus' });
  });
  it('e-mail de saldo sem assunto de clube vira evento de saldo; promoção sem saldo é ignorada', () => {
    const saldo = { id: 'm-saldo', from: 'livelo@mail.pontolivelo.com.br', date: '2026-10-24T14:47:39Z', subject: 'Direcione seus pontos Livelo', text: 'Saldo em 23/10/2026 7.230 pts Mais escolhas' };
    // O e-mail é de 24/10 mas o saldo citado é o de 23/10: a data do saldo vale mais que a do e-mail.
    expect(parseWalletMail(saldo)).toMatchObject({ kind: 'balance', program: 'Livelo', balance: 7230, balanceAt: '2026-10-23T12:00:00.000Z' });
    // Já o "Total de pontos" depois do crédito é do instante do e-mail.
    expect(parseWalletMail(livelo)?.balanceAt).toBeNull();
    expect(parseWalletMail({ ...saldo, text: 'Aproveite nossas ofertas' })).toBeNull();
    expect(parseWalletMail({ ...saldo, from: 'alguem@exemplo.com' })).toBeNull();
  });
  it('pesquisa de satisfação da Livelo (pontos de parceiro) não conta como crédito de clube', () => {
    const pesquisa = { id: 'm-pesquisa', from: 'pesquisa@livelofidelidade.com.br', date: '2026-10-22T20:28:31Z', subject: 'Seus pontos chegaram! Conte pra gente se deu tudo certo!', text: 'Olá, Carlos! Os pontos que você juntou com a compra no parceiro ELO já chegaram! Conte pra gente' };
    expect(parseWalletMail(pesquisa)).toBeNull();
  });
  it('números e dinheiro em formato brasileiro', () => {
    expect(parseMiles('33,500')).toBe(33500);
    expect(parseMiles('556.151')).toBe(556151);
    expect(parseMiles('sem número')).toBeNull();
    expect(parseMoneyCents('R$ 1.356,80')).toBe(135680);
  });
});
