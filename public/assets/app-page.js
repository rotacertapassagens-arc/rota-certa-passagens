// Página /app: registra o app (service worker) e cuida do botão "Instalar o app".
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
let installPrompt = null;

if ('serviceWorker' in navigator) window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => {}); });
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
window.addEventListener('appinstalled', () => { installPrompt = null; });

if (isStandalone()) {
  document.querySelectorAll('[data-install-app]').forEach((button) => {
    button.textContent = 'Abrir o Planner';
    button.addEventListener('click', () => { location.href = '/#/planner'; });
    button.removeAttribute('data-install-app');
  });
}

document.addEventListener('click', async (event) => {
  const trigger = event.target.closest('[data-install-app]');
  if (!trigger) return;
  event.preventDefault();
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    return;
  }
  window.alert(isIos
    ? 'Para instalar no iPhone: no Safari, toque em Compartilhar (o quadrado com a seta para cima) e depois em "Adicionar à Tela de Início".'
    : 'Para instalar: abra o menu do navegador (os três pontinhos) e escolha "Instalar app" ou "Adicionar à tela inicial".');
});
