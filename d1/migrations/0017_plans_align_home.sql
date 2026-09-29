-- Alinha os planos do painel com os da página inicial (Free 10 dias, Premium, Personalizado).
-- O plano 'free' (sem prazo) nasceu no teste de plano grátis permanente (0002) e continuou ativo por
-- engano quando o teste de 10 dias voltou (0003). Nada no sistema usa esse plano: todo cadastro
-- recebe o 'trial-10d'. Ele é só desativado (não apagado), para não perder histórico.
UPDATE plans SET active=0, checkout_enabled=0, name='Rota Certa Free sem prazo (desativado)' WHERE code='free';
UPDATE plans SET name='Rota Certa Free' WHERE code='trial-10d';
UPDATE plans SET name='Planejador Rota Certa Personalizado' WHERE code='personalized';
