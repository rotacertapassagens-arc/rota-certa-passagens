// Guias de viagem: filtro por região (Brasil, Portugal, Europa), ligado ao endereço (/blog/#europa),
// para os cartões de destino da página inicial abrirem a lista já filtrada.
const filtros = [...document.querySelectorAll('.bl-filter')];
const cartoes = [...document.querySelectorAll('.bl-list .post-card')];

function aplicar(regiao) {
  const valida = filtros.some((f) => f.dataset.regiao === regiao) ? regiao : 'todos';
  filtros.forEach((f) => f.setAttribute('aria-pressed', String(f.dataset.regiao === valida)));
  cartoes.forEach((cartao) => {
    cartao.hidden = valida !== 'todos' && cartao.dataset.regiao !== valida;
    // o cartão grande de destaque só faz sentido na lista completa
    cartao.classList.toggle('pc-featured', valida === 'todos' && cartao.dataset.destaque === 'sim');
  });
}

if (filtros.length && cartoes.length) {
  filtros.forEach((f) => f.addEventListener('click', () => {
    const regiao = f.dataset.regiao;
    history.replaceState(null, '', regiao === 'todos' ? location.pathname : `#${regiao}`);
    aplicar(regiao);
  }));
  addEventListener('hashchange', () => aplicar(location.hash.slice(1)));
  aplicar(location.hash.slice(1) || 'todos');
}
