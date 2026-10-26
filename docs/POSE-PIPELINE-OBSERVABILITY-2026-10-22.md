# OBS-01 — tempos observados da consulta de poses

Card: https://trello.com/c/1L9pnuQh

## Escopo e compatibilidade

Instrumentação aditiva do widget e de seu proxy Python. Não muda polling,
retentativas, cache, ordenação, duração dos sinais ou binários Unity/WebGL.
Nenhum `.pose`, perfil de mãos ou cena foi alterado. Este PR não exige recompilar
Unity; é uma atualização separada do wrapper/API no Avatar3DFrontend.

O proxy acrescenta `timings_ms` às respostas de submit e status. O widget
acrescenta `timingsMs` e, se informado, `poseCacheHit` aos eventos já existentes
`neotalk:prefetch-ready` e `neotalk:pose-ready`. Consumidores antigos ignoram os
campos novos; proxy antigo deixa os spans internos ausentes, sem inventar zeros.

## Fronteiras

| Campo no evento | Medida |
|---|---|
| total_ms | início do fetchSignPose até pose pronta na API, antes do download do arquivo pelo navegador |
| submit_request_ms | soma das requisições de submit no navegador, inclusive falhas |
| poll_request_ms | soma das requisições de status no navegador, inclusive falhas |
| poll_wait_ms | espera efetivamente observada entre consultas, incluindo escalonamento do navegador |
| retry_wait_ms | espera efetivamente observada nas retentativas de submit |
| proxy_upstream_submit_ms | chamada bem-sucedida do proxy para submit na API de sinais |
| proxy_upstream_status_ms | soma das chamadas bem-sucedidas do proxy para status |
| proxy_storage_lookup_ms | consulta local e verificação de existência do arquivo original |
| proxy_download_ms | download da API de sinais para o armazenamento do proxy |
| proxy_validation_persist_ms | validação e persistência local da pose |

`poseCacheHit` refere-se somente ao arquivo no armazenamento do proxy naquela
consulta, não ao cache do widget, HTTP ou Unity. Em hit, download/persistência
ficam ausentes. Tempos do proxy são contidos nas requisições do navegador:
**não somar novamente**. A conclusão do worker é apenas observada por polling;
não há medição isolada da fila, computação ou intervalo ocioso desse worker.
Não inclui download proxy→navegador, preparação Unity ou apresentação na GPU.

Falhas sem resposta completa não fornecem spans internos. Cancelamento/erro
terminal não emite uma amostra de sucesso. A plataforma mantém amostras
ausentes explícitas; isso não substitui um coletor de tentativas fracassadas.

## Evidência local e gate

- 21 testes Node passaram: clock controlado comprova separação das esperas,
  retentativa 502, compatibilidade com proxy antigo e cancelamento; o restante
  cobre reprodução, prefetch, espelhamento e contrato nativo existente.
- 16 testes Python passaram: submit, status pendente, download frio e segunda
  consulta em cache; download ocorre uma vez, sem tempo de download inventado.
- API de sinais simulada nesses testes; não houve chamada a GPT ou produção.
- Nenhum ganho de velocidade é alegado. Falta publicar em homologação, coletar
  ao menos 100 lotes reais frio/quente e comparar por saída antes de otimizar.
- Integração da coleta admin na plataforma: PR #2 de neotalk-eventos.

Os dois repositórios podem ser atualizados em qualquer ordem; o relatório
completo requer ambos. A aplicação anterior continua funcionando com spans
ausentes. Não houve merge ou deploy nesta validação local.
