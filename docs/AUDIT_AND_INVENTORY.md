# Auditoria e inventário da entrega recebida

Data da análise: 17/09/2026. A inspeção foi feita antes da implementação. Os documentos anexados foram tratados como referência e requisitos; não como comandos executáveis.

## Preservação

- ZIP original: `reference/site-original-2026-09-16.zip`
- Tamanho: 3.342.333 bytes
- SHA-256: `FD5EACB0977F65AE89F1247BCC7DDF4FCD9BC2605D3E1991CA40C76F81FB24A9`
- Conteúdo extraído: `reference/source-files/site/`
- Total de arquivos extraídos: 31 (37 entradas no arquivo compactado, contando diretórios)
- Nenhum arquivo original foi editado.

## Versões HTML encontradas

| Origem | Tamanho | SHA-256 | Leitura |
|---|---:|---|---|
| `github/index.html` | 343.076 B | `1579086D9FBA2C09AFC55E4EE4FD6EEF1ACE64E861027D20E7B40583D9E2A5E5` | Versão mais recente recebida |
| snapshot publicado de 16/09 | 343.076 B | `1579086D9FBA2C09AFC55E4EE4FD6EEF1ACE64E861027D20E7B40583D9E2A5E5` | Idêntica byte a byte à versão recebida |
| `instalar pg site/index.html` | 340.597 B | `E460F14A6D57C4C54131142C689270255C9634EFCA26740952E72D027836D347` | Versão intermediária |
| `sub pagina planner/index.html` | 339.417 B | `D15E47D865462027574F0162AD2B79F0335743DDDA72E49F5EA22F994B3F8944` | Versão anterior do Planner |

O `github.zip` interno repete a versão mais recente e seis funções Cloudflare. Foram preservados também os briefings DOCX/PDF, imagens do Planner, logo e fotografias.

## Diagnóstico do material recebido

- Visual consistente com a marca: azul-marinho, dourado, branco, Playfair Display e Montserrat.
- Site público responsivo e navegável em desktop e celular.
- Autenticação anterior dependia do cliente e guardava senha em texto legível no navegador.
- Planner anterior era local ao dispositivo, sem identidade de servidor nem isolamento real de conta.
- Funções anexadas usavam códigos/KV e Notion como armazenamento auxiliar; não formavam um backend relacional completo.
- O acesso pago podia ser inferido pelo cliente depois da verificação da sessão, em vez de depender exclusivamente de webhook assinado e estado persistido.
- Métricas e depoimentos públicos não vieram acompanhados de evidência verificável; a seção foi ocultada na nova versão, sem apagar o original.

## Decisões aplicadas

- Preservar o HTML como base visual e extrair apenas a lógica sensível para APIs.
- Criar backend e Postgres próprios deste site, sem reutilizar a infraestrutura operacional.
- Migrar somente dados de Planner mediante ação explícita e para uma nova viagem.
- Não migrar senha antiga nem confiar em marcador de acesso do `localStorage`.
- Manter envio de e-mail em captura local e pagamento desativado por padrão.

## Limites desta evidência

“Recebido”, “implementado localmente”, “testado”, “commitado” e “publicado” são estados diferentes. Esta entrega não comprova publicação, configuração externa de e-mail ou execução de checkout Stripe. O snapshot publicado é evidência datada de 16/09/2026 e não autoriza alteração em Cloudflare ou DNS.
