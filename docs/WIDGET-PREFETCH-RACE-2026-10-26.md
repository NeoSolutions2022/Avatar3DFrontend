# PERF-03 — corrida de prefetch, 26/10/2026

Card: https://trello.com/c/0f1Jzzm7. Candidata no PR #40, sem merge/deploy.

## Defeito reproduzido

Na base `96aaaf4`, `state.prefetchTasks` guardava apenas a promessa de consulta
à API. O download antecipado do arquivo acontecia depois, fora dessa promessa.
Um `sign` recebido nesse intervalo encontrava a consulta resolvida e podia
chamar Unity com a URL original antes de os bytes estarem disponíveis no cache,
concorrendo com o download antecipado. Também faltava limite de trabalhos de
consulta e o callback de validade passado à consulta era sempre verdadeiro.

Três regressões falharam na base: carga antes de o warmup terminar, quatro
consultas em vez de duas e geração antiga ainda elegível. Não são testes de GPU.

## Correção

A promessa em voo agora inclui consulta + warmup. Não espera novo temporizador:
reaproveita o trabalho já iniciado. O download tem timeout existente de oito
segundos; se falhar, retorna o resultado e permite carregamento normal pela URL.
Isso pode adicionar espera em uma transferência lenta comparado ao antigo
comportamento de disparar outra em paralelo; não há ganho universal garantido.

Até dois trabalhos antecipados na geração atual. `prefetch_busy` é emitido
como `prefetch-error`, nunca erro terminal de reprodução; não há mute, reset,
troca de pose, corte de frames ou alteração do polling. Troca de avatar invalida
a elegibilidade; requisição HTTP já em voo não é abortada instantaneamente.
Os limites de arquivos continuam quatro entradas/32 MiB, cada arquivo até 16 MiB.

## Verificação

- 28 testes Node aprovados, incluindo sete novos em
  `tests/widget-prefetch-race.test.cjs`.
- Burst controlado de 100 pedidos: dois trabalhos antecipados, 98 notificações
  não bloqueantes; pedido sob demanda posterior funciona. Não representa fala real.
- 502 no warmup libera o slot, e sign posterior tenta novamente sem tarefa presa.
- HTTP loopback real com corpo retido enquanto sign chega: uma transferência
  da origem; bytes consumidos exatamente iguais. API e chamada Unity controladas
  nesse teste, sem alegação de renderização ou ganho de velocidade.
- Execução do HTTP loopback precisa de permissão de rede local; timeout explícito
  evita deixar o teste preso quando a sandbox bloqueia a conexão. Uma execução
  restrita expirou; repetição autorizada passou. Não foi falha do runtime do produto.
- Integração separada com plataforma real, GPT/NeoTalk e dois Unity reais,
  Document PiP nativo/Edge 155.0.4283.62, ASR pt-BR injetado: cinco lotes/35
  palavras completos nos dois players, zero pausa/reset/rejeição. Três consultas
  reais, três amostras de spans e dois replays em memória. 94,344 s de duração.
  Dados privados na plataforma: `outputs/real-services-1793026240445`.
- Base anterior na mesma máquina: cinco lotes também passaram, 99,095 s. GPT,
  polls, duração dos clips e cache variaram; **não usar como percentual de ganho**.
  Handoff PiP: mediana 513,5→511,4 ms, máximo/p95 558,6→636,6 ms (n=4 cada).
  Não demonstra melhora de fluidez; ensaio curto/repetido não cobre o catálogo.
- Pacote final `.30` recompilado como imagem Docker (sem recompilar Unity):
  três frases diferentes/21 palavras, três lotes completos em cada saída,
  todos os spans presentes, zero pausa/reset/rejeição, 50,259 s. Ambos os widgets
  anunciaram `2026.10.26-elia.30`. Arquivo privado na plataforma:
  `outputs/real-services-1793026741232`. Quatro testes Python de polling passaram.

## Build e limites

Mudança JavaScript/HTML somente, com versão/cache-buster `.30`. WebGL existente
foi copiado sem alteração para a imagem local; não se gerou novo Unity.
SHA-256 do manifest: `DBA4E3A1CD410D7F4E712B582B2E3A3D7E63387105F453833D3DDF104C1422F9`.
Imagem do ensaio comportamental: `sha256:5026e1858130094ecec474877697ea5b5789040ca090b0d6f52082451ea5e001`
(antes da mudança do rótulo de versão `.30`; mesmas funções de reprodução).
Imagem final `.30`: `sha256:6956cef8016553be8d5925cde4312dd3b3a378926d6d3f832f68ea7587373e74`.

Nenhuma cena, perfil de mãos, `.pose`, duração de sinal ou contrato Unity mudou.
PERF-02 continua necessário para preparação nativa; essa correção não resolve
a cauda de fila observada em 23/10. Faltam A/B repetido/estratificado, microfone
físico, palestra prolongada, falhas reais de rede e validação nos outros browsers.

Reproduzir na raiz: `node --test tests/*.test.mjs tests/*.test.cjs`.
O ensaio com Unity usa `tests/real-services-browser.cjs` no repositório da
plataforma, com homologação isolada; nunca apontar para banco de produção.
