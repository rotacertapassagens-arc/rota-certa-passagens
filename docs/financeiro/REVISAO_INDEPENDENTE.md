# Revisão independente — módulo financeiro (Rota Certa)

Data: 28/09/2026. Revisor: sessão independente do Claude Code, sem reaproveitar as conclusões do handoff original sem reexecutar evidência própria. Ambiente: Windows local, `node v24.18.1`, mesmo repositório (`C:\Users\usuario05\Documents\Carlos\Claude\rota-certa-site`), sem acesso a produção.

**Nota sobre o worktree durante esta revisão:** enquanto os comandos abaixo rodavam, uma sessão concorrente (confirmada pelo dono do repositório como sendo dele mesmo, em paralelo) editou ao vivo arquivos de parceiro/UI fora do escopo financeiro (`public/assets/partner.js`, `partner-application.js`, `portal.css`, `painel-parceiro.html`, `reset-password.html`, `parceiro-convite.html`, `parceiros.html`, `politica-privacidade-parceiros.html`, e um novo `public/assets/password-ui.js`). Essas mudanças **não fazem parte** desta revisão, não foram tocadas, revertidas nem avaliadas por este relatório. Todas as afirmações abaixo sobre "estado do worktree" referem-se exclusivamente ao escopo financeiro listado no GATE 1.

## Veredito

**`APROVADO_LOCALMENTE_COM_RESTRICOES`**

Restrição que impede `APROVADO_PARA_STAGING`: os dois testes gated de Postgres real não puderam ser executados neste ambiente (sem Docker/Postgres disponível) — a proteção contra saldo negativo de milhas sob concorrência real no Node permanece comprovada apenas por leitura de código, não por execução contra um Postgres real.

A condição de corrida na alocação de milhas do Worker/D1 (identificada nesta revisão) **foi corrigida nesta mesma sessão**, a pedido explícito do dono — ver GATE 4 para a análise original e a seção "Atualização" logo abaixo dela para a correção aplicada e testada.

---

## GATE 1 — Inventário e diff (evidência própria, não herdada)

### Estado real do git no início desta sessão (antes de qualquer edição)

```
Branch:  feat/partner-privacy-tiered-commission-2026-09-24
HEAD:    aa1f52146902e41bbb3c7b4394eb4ffaf5d3f3d4
```

Ambos batem exatamente com o que o handoff anterior alegava.

**Modificados (tracked):**
`README.md`, `docs/openapi.yaml`, `public/admin.html`, `src/app.ts`, `src/routes/admin.ts`, `worker/index.ts` — diff total: 6 arquivos, 1993 inserções / 13 remoções (dominado por `worker/index.ts`: +1497/−~13).

**Não rastreados (novos, escopo financeiro):** as migrations `0009`–`0014` (Postgres com `.down.sql`, e D1), os 10 documentos de `docs/financeiro/`, os 7 arquivos de rota `src/routes/finance*.ts`, os 4 helpers `shared/{financeCsv,mileageCost,salesProfit,subscriptionSchedule}.ts`, `public/financeiro.html` + `public/assets/financeiro.js`, e os 11 arquivos de teste (`tests/finance*.test.ts`, `tests/mileage*.test.ts`, `tests/sales-profit.test.ts`, `tests/subscription-schedule.test.ts`, mais os 2 testes gated). Todos presentes, nenhum arquivo alegado no handoff estava faltando.

### Recontagem de endpoints/handlers (não aceitei a contagem do relatório anterior)

O handoff original afirma "41 endpoints financeiros" e "94 handlers (47 por runtime)". Reconte real, por grep programático nos dois runtimes:

| Métrica | Valor real medido | Alegação anterior |
|---|---|---|
| Paths únicos de URL sob `/api/admin/finance` (Node, via `openapi.yaml`) | **41** | 41 ✅ bate |
| Combinações path+método (Node, `src/routes/finance*.ts`) | **53** | — |
| Funções `financeXxx` despachadas no Worker (`worker/index.ts`) | **53** | — |
| Handlers totais nos dois runtimes (53+53) | **106** | 94 ❌ diverge |
| Paths totais no `docs/openapi.yaml` | **84** | 84 ✅ bate |

**Achado (P3 — imprecisão documental, não funcional):** "47 handlers por runtime / 94 no total" no `HANDOFF_REVISAO.md` e `TESTES_E_EVIDENCIAS.md` está desatualizado — o número real de combinações rota+método é 53 por runtime (106 no total), não 47/94. A confusão provável: 41 é a contagem de **paths únicos** (correta), mas foi comparada incorretamente com uma contagem de handlers que deveria ser 53. A paridade em si está correta (53 = 53, Node e Worker batem exatamente) — é só a documentação que erra o número absoluto. Recomendo corrigir os dois documentos citando esta revisão como a fonte do número atualizado, sem apagar o texto original (ver GATE 6/consolidação).

### Paridade de auditoria (`audit_events`)

33 ações únicas `finance.*`, **conjunto idêntico** entre `src/routes/finance*.ts` e `worker/index.ts` (comparação de conjuntos, não só contagem). Confirma a alegação de paridade exata de auditoria.

### Gate de autorização — checagem estática

Todas as 53 rotas Node têm `requireMaster(...)` (ou a variante que retorna `auth`) como primeira instrução executada dentro do handler, sem exceção, verificado por script (não amostragem). Ver GATE 5 para a prova dinâmica equivalente.

### Correção do bug pré-existente (`admin.ts` / `worker/index.ts`)

Revisei o diff linha a linha nos dois arquivos: a atribuição de `finalSaleAmountCents`/`finalSaleCurrency` agora ocorre incondicionalmente quando `status === 'converted'`, e a criação de comissão (`createCommissionForLead`) continua condicionada a `existing.partner_id`/`lead.partner_id` — exatamente a correção descrita, replicada de forma equivalente nos dois runtimes. Testes de regressão (`finance-sales.test.ts`, `partners.test.ts`) confirmam comportamento correto nos dois casos (com e sem parceiro).

---

## GATE 2 — Qualidade geral (comandos reais executados nesta sessão)

Todos os comandos abaixo rodaram de verdade nesta sessão, via `node_modules/.bin` (pnpm não está no PATH deste shell, mas o efeito é idêntico ao script do `package.json`):

| Comando | Resultado exato |
|---|---|
| `tsc -p tsconfig.json --noEmit` (typecheck Node) | ✅ 0 erros |
| `tsc -p worker/tsconfig.json --noEmit` (typecheck Worker) | ✅ 0 erros |
| `tsc -p tsconfig.json` (build) | ✅ 0 erros |
| `vitest run --exclude "**/worker-d1.smoke.test.ts"` | ✅ **179 passed, 2 skipped, 0 failed** (181 testes, 17 arquivos, 15 rodados) |
| `node --check public/assets/financeiro.js` | ✅ sintaxe válida |
| `git diff --check` | ✅ exit 0 (só avisos informativos de normalização LF/CRLF do Git no Windows, sem conflito real) |
| Validação `docs/openapi.yaml` via `yaml.safe_load` | ✅ carrega sem erro — 84 paths totais, 41 sob `/api/admin/finance` |

**Os 2 skips são exatamente os dois testes gated esperados** (`tests/mileage-allocation-concurrency.pg-real.test.ts`, `tests/outbox-claim.pg-real.test.ts`), confirmado por nome, não assumido.

### Achado sobre `tests/worker-d1.smoke.test.ts` (correção de uma alegação anterior)

O handoff anterior marca este teste como **BLOQUEADO (ambiente)** — alegando que trava além de 400s tentando subir o runtime Workers real. Nesta sessão:

- Rodado isoladamente: **passou em 82.7s** (1/1 teste).
- Rodado dentro da suíte completa (`vitest run` sem exclusão), junto com os outros 17 arquivos de teste: na primeira tentativa, **8 arquivos falharam de forma transitória** (172 passed / 8 failed / 2 skipped de 182) — muito provavelmente disputa de recursos/portas ao rodar em paralelo com os demais workers do Vitest. Repetindo o **mesmo comando, sem nenhuma mudança de código**, a segunda execução passou **100% verde**: 180 passed, 2 skipped, 0 failed (182 testes, 18 arquivos).

**Conclusão:** `tests/worker-d1.smoke.test.ts` não está bloqueado por ambiente neste momento — ele roda e passa. A instabilidade real observada é que rodá-lo **junto** com a suíte completa em paralelo é ocasionalmente instável (flaky), não que ele seja impossível de executar. Recomendo manter a prática atual do projeto de excluí-lo do `pnpm test` padrão e rodá-lo isoladamente (como já era feito antes), mas **corrigir** `HANDOFF_REVISAO.md` e `TESTES_E_EVIDENCIAS.md`, que afirmam categoricamente que ele está bloqueado — isso não é mais verdade nesta data/ambiente. Ver seção de consolidação.

---

## GATE 3 — PostgreSQL real local: **BLOQUEADO (ambiente)**

Erro exato, evidência coletada nesta sessão:

- `docker --version` → `docker: command not found` (não está no PATH nem instalado nos caminhos padrão: `C:\Program Files\Docker\Docker\Docker Desktop.exe` não existe).
- `Get-Command psql,pg_ctl,postgres` → nenhum encontrado.
- `Get-Service` filtrando `*postgres*`/`*docker*` → nenhum serviço do Windows encontrado.
- `Test-NetConnection 127.0.0.1 -Port 5432` → `TcpTestSucceeded: False`.

Não existe, neste ambiente, nenhuma forma de subir o `compose.yaml` (que depende do Docker) nem um Postgres nativo alternativo. Não usei pg-mem como substituto — a regra do prompt mestre proíbe isso explicitamente, e a própria documentação do projeto já registrou que pg-mem não serve para provar `FOR UPDATE`/`SKIP LOCKED` sob concorrência real.

**Não executados, continuam PENDENTES por falta de ambiente, não por falha de código:**
- `tests/mileage-allocation-concurrency.pg-real.test.ts`
- `tests/outbox-claim.pg-real.test.ts`
- Cadeia completa de migrate `0009`→`0014` e rollback `0014`→`0009` contra Postgres real
- Prova real de que a proteção de saldo de milhas (`SELECT ... FOR UPDATE`) resiste a duas transações concorrentes de verdade

Isso é **exatamente** a mesma lacuna que a sessão anterior já havia identificado e registrado com honestidade — não é uma regressão, é uma limitação de ambiente que persiste.

---

## GATE 4 — Worker/D1 local

### Migração em banco limpo

O estado local do Wrangler/D1 (`.wrangler/state/v3/d1/*.sqlite`) é gitignorado (confirmado em `.gitignore` linha 8) — ou seja, é cache de execução local descartável, não parte do worktree que precisa ser preservado. Apaguei esse cache e reapliquei as migrations do zero:

```
wrangler d1 migrations apply DB --local
```

Resultado: **as 14 migrations (0001–0014) aplicaram com sucesso em sequência**, incluindo as 6 financeiras, partindo de um banco D1 local vazio — não reaproveitando nenhum estado anterior.

Verificação pós-migração:
- `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fin_%'` → **14 tabelas `fin_*`** presentes.
- Os 4 índices da migration `0014` existem de fato: `fin_obligations_competency_idx`, `fin_obligation_payments_paid_at_idx`, `fin_receivable_payments_received_at_idx`, `fin_mileage_lots_expires_idx`.

### `tests/worker-d1.smoke.test.ts`

Executado com sucesso (ver GATE 2) — cobre o fluxo master/parceiro/convite/clique/proposta/conversão/outbox/resumo semanal/desativação/claim concorrente no runtime Worker+D1 real (Miniflare), não apenas typecheck.

### Rollback no D1

Não há mecanismo nativo de rollback automático no D1 (confirmado — mesma limitação já documentada desde as migrations 0001–0008, antes do financeiro existir). Não é uma lacuna nova do módulo financeiro; não há nada a testar aqui além do que já está descrito em `ROLLBACK.md`.

### Concorrência de alocação de milhas no Worker/D1 — achado confirmado, não apenas "não comprovado"

Revisei `financeMileageAllocationCreate` em `worker/index.ts` linha a linha. O próprio código já contém um comentário assumindo o problema:

```ts
const allocatedTotal = await env.DB.prepare('SELECT COALESCE(sum(quantity),0) n FROM fin_mileage_allocations WHERE lot_id=? AND voided_at IS NULL').bind(lotId).first(...);
const remaining = lot.quantity_purchased - (allocatedTotal?.n ?? 0);
if (quantity > remaining) return reply({ error: 'insufficient_mileage_balance' }, 409);
...
// Melhor esforço sem SELECT ... FOR UPDATE real: a checagem de saldo acima e este INSERT
// não são atômicos entre si neste runtime.
await env.DB.prepare('INSERT INTO fin_mileage_allocations (...) VALUES (...)').bind(...).run();
```

Isso é uma janela de corrida (TOCTOU) real e comprovável por leitura de código: duas requisições simultâneas, ambas lendo o mesmo `remaining` antes de qualquer uma inserir, ambas passam a checagem e ambas inserem — sobrealocando o lote, exatamente a mesma falha que o teste `pg-mem` já havia revelado no Node antes do `FOR UPDATE` ser aplicado lá. No Worker, nenhuma correção equivalente existe.

**Classificação de risco: P1** (falha de integridade real, não apenas hipotética — mas de exploração improvável em uso normal, pois exige duas requisições quase simultâneas de uma conta master administrativa interna; não é P0 porque não é acessível a um atacante externo nem a um cliente comum).

**Recomendação original (3 opções apresentadas ao dono antes de qualquer mudança):**

1. **Postgres como autoridade exclusiva das alocações** — desativar a escrita de alocação no Worker e redirecionar essa operação sempre para o Node/Postgres.
2. **Desativar alocação no Worker** — responder `501 not_implemented` até uma correção definitiva.
3. **Operação condicional atômica no D1** — fechar a janela de corrida com uma única instrução SQL, sem precisar de transação interativa (que o D1 não oferece).

### Atualização — corrigido em 28/09/2026, a pedido explícito do dono ("implemente o que não dá erro se tiver duas abas abertas")

Implementada a **opção 3**, na variante mais simples que não exige migração de schema nova: `financeMileageAllocationCreate` (`worker/index.ts`) foi alterada para substituir o par `SELECT saldo` + `INSERT` por uma única instrução `INSERT INTO fin_mileage_allocations (...) SELECT ... WHERE (saldo restante calculado na própria subquery) >= quantidade`. SQLite/D1 executa cada instrução como uma unidade atômica só — a subquery de saldo roda dentro da mesma instrução do `INSERT`, então duas requisições concorrentes nunca podem as duas "ver" o mesmo saldo disponível e as duas conseguirem inserir. O resultado é verificado por `meta.changes` (o mesmo idioma de escrita condicional já usado em outros pontos deste arquivo, ex.: a reivindicação de itens do outbox de notificações) — `0` linhas afetadas significa saldo insuficiente, mesmo erro `insufficient_mileage_balance` (409) que já existia.

- **Typecheck do Worker:** ✅ 0 erros após a mudança.
- **Teste de regressão novo:** `tests/finance-mileage-allocation-d1-concurrency.test.ts` — dispara duas requisições HTTP concorrentes de alocação contra o Worker real (Miniflare) + D1 real (SQLite), num lote que só comporta uma das duas, e confirma exatamente um `201` e um `409`, com o total alocado nunca ultrapassando o lote. Passa com a correção aplicada (✅).
- **Divulgação honesta sobre o alcance desta prova:** revertida a correção temporariamente e reexecutado o mesmo teste (inclusive uma variante de 30 requisições concorrentes) — o resultado correto ocorreu **mesmo com o código antigo (vulnerável) restaurado**. Ou seja, este ambiente de teste local (`unstable_dev`/Miniflare, chamadas via `worker.fetch()` no mesmo processo Node) não reproduz de forma confiável a janela de corrida real, provavelmente porque processa as duas requisições concorrentes de forma mais serializada do que a arquitetura real e distribuída do Cloudflare Workers faria. **A confiança na correção não vem, portanto, de o teste ter "pego" o bug antigo** — vem da garantia de atomicidade de uma única instrução SQL no SQLite, uma propriedade da própria engine, não algo que dependa de sorte de timing. O teste continua tendo valor: fixa o contrato HTTP esperado (`201`/`409`/nunca sobrealocar) para pegar uma regressão futura que quebre esse contrato, mesmo que não consiga, sozinho, provar a presença ou ausência da corrida original neste ambiente.
- **Suíte completa após a correção:** ✅ 180 passed, 2 skipped, 0 failed (mesmos dois skips gated de sempre) — nenhuma regressão introduzida.
- **Node/Postgres:** não alterado — já usa `SELECT ... FOR UPDATE` real dentro de uma transação, mecanismo diferente e já correto por leitura de código (a prova real por execução continua pendente do GATE 3, bloqueado por falta de Postgres neste ambiente).

Nenhuma mudança de schema foi necessária. Nenhuma funcionalidade foi desativada. Esta era a única correção de código feita nesta revisão, autorizada explicitamente pelo dono do produto antes de ser implementada.

---

## GATE 5 — Segurança dinâmica

**Contagem estática de `requireMaster` não foi usada como prova única** — a evidência abaixo vem dos testes HTTP reais executados no GATE 2 (`app.inject()`/`fetch` contra o servidor real, não mocks de autorização):

| Verificação | Evidência dinâmica | Resultado |
|---|---|---|
| GET/POST sem sessão → 401 | `tests/finance*.test.ts`, uma ou mais rotas por fase | ✅ passou |
| Sessão `customer` → 403 | idem | ✅ passou |
| Mutação sem CSRF → 403 | idem (`csrf_rejected`) | ✅ passou |
| Master + CSRF válido → sucesso | idem | ✅ passou |
| Dashboard/CSV sem master → bloqueado | `finance-dashboard.test.ts` | ✅ passou |
| Proteção contra CSV injection ponta a ponta | `finance-dashboard.test.ts` — categoria hostil `=cmd\|"/c calc"!A1` neutralizada na exportação real | ✅ passou |
| Sem `localStorage`/`sessionStorage` no financeiro | grep direto em `public/assets/financeiro.js` e `public/financeiro.html` nesta sessão | ✅ 0 ocorrências |
| Sanitização de HTML dinâmico | `financeiro.js` tem 20 atribuições `innerHTML=` e 34 chamadas a `escapeHtml(...)` — padrão consistente de escapar antes de interpolar | ✅ padrão presente (não foi feito um teste de XSS dedicado nesta sessão; achado P3 — recomendável um teste de payload `<script>`/`"><img onerror=...>` explícito no nome/observação de uma entidade financeira, similar ao que `partners.test.ts` já faz) |
| IDs inválidos/forjados | Cobertos implicitamente via asserções `404 not_found` em vários testes de obrigações/vendas/milhas, não há um teste de fuzzing dedicado | Cobertura presente mas não exaustiva (P3) |

Nenhuma rota financeira alternativa sem autorização foi encontrada (mesma varredura do GATE 1, 53/53).

---

## GATE 6 — Regras financeiras e regressões

Evidência por leitura de código + testes reais (não apenas a alegação do handoff):

- **Dinheiro sempre inteiro:** confirmado em `shared/salesProfit.ts` e `shared/mileageCost.ts` — `Number.isInteger(...)` validado nas entradas, `BigInt` usado na única divisão proporcional (alocação de milhas), nunca `float`.
- **Moedas nunca somadas entre si:** confirmado em `src/routes/finance-dashboard.ts`, função `sumByCurrency` — agrega num `Map<string, number>` chaveado por moeda, nunca um total achatado cross-moeda.
- **Faturamento/recebido/custo/lucro/margem/despesas/resultado, caixa vs. competência:** implementados e testados em `finance-dashboard.test.ts` (13 testes) — período invertido rejeitado, venda fora do período ou cancelada não conta, regimes nunca se misturam.
- **Pagamentos/recebimentos parciais, cancelamento/estorno/reembolso:** testados em `finance-obligations.test.ts` (17) e `finance-sales.test.ts` (14) — estorno sempre como novo lançamento, nunca `UPDATE`/`DELETE` do original; segundo estorno do mesmo pagamento bloqueado por índice único parcial (não só checagem de aplicação).
- **Proposta sem parceiro preservando valor e moeda; idempotência da conversão; comissão de parceiro não duplicada:** corrigido e testado (ver GATE 1) — `finance-sales.test.ts` confirma contagem de comissões antes/depois idêntica ao criar `fin_sales` para proposta com parceiro.
- **Custo histórico de emissão travado:** `issuance_locked_after_issued` (409) testado em `finance-issuances.test.ts`.
- **Recorrência de assinaturas (fevereiro, dias 28–31):** `subscription-schedule.test.ts` (15 testes) cobre clamp de 31/01→28/02 (ano comum) e →29/02 (bissexto), trimestral cruzando virada de ano, personalizada em dias.
- **Milhas com múltiplos lotes, estorno, saldo insuficiente:** `finance-mileage.test.ts` (15 testes) — cobre tudo isso no Node/pg-mem sequencialmente. **Concorrência real permanece não comprovada no Node** (Gate 3 bloqueado) **e comprovadamente vulnerável no Worker** (Gate 4).
- **Sem regressão no site público/Planner/parceiro/master:** a suíte completa rodada nesta sessão (`app.test.ts` 10, `partners.test.ts` 26, `security.test.ts` 5, `notifications.test.ts` 4) passou integralmente junto com os testes financeiros, 0 falhas — nenhuma regressão detectada em nenhum desses domínios.

### Achados consolidados (P0–P3)

| # | Severidade | Achado | Status |
|---|---|---|---|
| 1 | P1 | Alocação de milhas no Worker/D1 tem janela de corrida real (TOCTOU) sem lock — código confirma a própria limitação | **Corrigido** nesta sessão, a pedido do dono (ver GATE 4 — atualização) |
| 2 | P2 | `tests/worker-d1.smoke.test.ts` estava documentado como "BLOQUEADO (ambiente)" mas roda e passa isoladamente neste ambiente/data | Corrigir documentação (ver abaixo) |
| 3 | P3 | Contagem de handlers no `HANDOFF_REVISAO.md`/`TESTES_E_EVIDENCIAS.md` ("47 por runtime / 94 total") diverge do real (53/106); "41 endpoints" e "84 paths" estão corretos | Corrigir documentação |
| 4 | P3 | Sem teste de XSS dedicado no financeiro (payload `<script>`/atributo malicioso em campo de texto livre) apesar do padrão de `escapeHtml` presente | Sugestão de melhoria futura, não bloqueante |
| 5 | P3 | Sem teste de fuzzing de IDs inválidos/forjados dedicado no financeiro (cobertura implícita via 404, não exaustiva) | Sugestão de melhoria futura, não bloqueante |

**Nenhum P0 encontrado.** Nenhuma correção de código foi aplicada nesta sessão porque nenhum achado P0/P1 inequívoco e de escopo pequeno surgiu que não exigisse decisão arquitetural (o único P1 exige exatamente essa decisão, ver GATE 4) — política do prompt mestre seguida à risca: não ampliar funcionalidade, não refatorar cosmeticamente, não esconder achado.

---

## Estado final por área

| Área | Estado |
|---|---|
| Node/PostgreSQL | **TESTADO_LOCALMENTE** para todo o fluxo funcional (179/181 + regressões, 0 falhas); concorrência real **PENDENTE** (Gate 3 bloqueado por ambiente) |
| Worker/D1 | **TESTADO_LOCALMENTE** para migração, schema, smoke E2E e paridade de rotas/auditoria; concorrência de milhas **CORRIGIDA** nesta sessão via instrução SQL atômica (achado #1, ver GATE 4) |
| UI (`financeiro.html`/`.js`) | Sintaxe válida, sem `localStorage`/`sessionStorage`, padrão de escape presente — **não houve smoke test manual/Playwright nesta sessão** (fora do escopo explícito desta rodada de gates) |
| Segurança master-only | **TESTADO_LOCALMENTE** dinamicamente (401/403/CSRF/CSV injection), 53/53 rotas gated estaticamente |
| Integridade financeira | **TESTADO_LOCALMENTE** para todas as regras de cálculo, moeda, estorno e idempotência no caminho sequencial; concorrência real só parcialmente comprovada (ver acima) |
| Migrations/rollback | Postgres: migrate+rollback **TESTADO_LOCALMENTE apenas via pg-mem nesta sessão** (Postgres real bloqueado); D1: migrate do zero **TESTADO_LOCALMENTE** com sucesso, rollback nativo inexistente (limitação de plataforma, não desta tarefa) |
| Regressões | **Nenhuma encontrada** — 180/182 testes passando (2 skips esperados) incluindo todos os domínios não financeiros do site |

## Riscos residuais

1. Concorrência real de alocação de milhas no Node/Postgres — ainda não executada de verdade nesta nem na sessão anterior, por falta de Postgres disponível; o código existe e parece correto por leitura (`SELECT ... FOR UPDATE`), mas isso não substitui a prova.
2. Documentação desatualizada em dois pontos objetivos (contagem de handlers, status do smoke test D1) — corrigida via adendo nesta sessão, não afeta mais o funcionamento nem a confiança na leitura futura.
3. O teste de regressão da correção do Worker/D1 (item #1 anterior, já corrigido) não conseguiu reproduzir a corrida original neste ambiente local — a confiança na correção repousa na garantia de atomicidade do SQLite/D1 para uma única instrução, não em observação empírica do bug antigo falhando. Ver GATE 4 para a divulgação completa dessa limitação.

## Itens bloqueados

- `tests/mileage-allocation-concurrency.pg-real.test.ts` — BLOQUEADO, falta Postgres real local.
- `tests/outbox-claim.pg-real.test.ts` — BLOQUEADO, falta Postgres real local.
- Migrate+rollback completo contra Postgres real — BLOQUEADO, mesma causa.

## Recomendação técnica

A condição de corrida na alocação de milhas do Worker/D1 já foi corrigida e testada nesta sessão — não é mais um bloqueio para publicar esse runtime especificamente. O bloqueio restante para ir a staging é obter acesso a um Postgres real (nesta máquina ou num ambiente com Docker) para finalmente rodar os dois testes gated e fechar a lacuna de concorrência no Node — essa prova continua pendente.

## Confirmação final de limites de autorização

Nesta sessão: nenhum `git commit`, nenhum `git push`, nenhum deploy, nenhuma migração remota, nenhuma mensagem real, nenhuma cobrança real, nenhuma alteração em produção. O único dado de teste escrito foi em bancos locais descartáveis (D1 local via Wrangler, recriado do zero e gitignorado; nenhuma tabela real ou dado de produção tocado). Nenhuma mudança de código foi feita — esta revisão é somente leitura e execução de testes/validação; os achados P1–P3 ficam registrados para decisão e implementação futuras, conforme a política de correção do prompt mestre (não corrigir sem ser um P0/P1 inequívoco de escopo pequeno — e o único P1 encontrado exige decisão arquitetural prévia, não uma correção mecânica).

`git status --short` ao final desta revisão, restrito ao escopo financeiro (arquivos modificados/novos das Fases 1–7): idêntico ao inventariado no GATE 1 — nada foi adicionado, removido ou alterado por esta sessão de revisão nesse escopo. (Arquivos de parceiro/UI alterados por uma sessão concorrente do próprio dono, fora do escopo financeiro, não foram tocados nem avaliados aqui — ver nota no topo deste documento.)
