# Crypto Panel — Roadmap de produto e dados

## Visão

Construir uma base confiável de inteligência de mercado cripto que concentre
indicadores e séries históricas, permitindo que pessoas e, futuramente, um
agente gerem relatórios de valuation auditáveis. Cada conclusão deve ser
rastreável a observações ponto-no-tempo, fontes, fórmulas e limitações.

## Princípios de implementação

- Dados brutos e derivados carregam fonte, horário de observação, cobertura,
  moeda, granularidade e estado de qualidade/freshness.
- Séries históricas são imutáveis; correções entram como uma nova observação ou
  revisão identificável, nunca como alteração silenciosa do passado.
- Cálculos vivem no backend e são reproduzíveis a partir de observações
  armazenadas. A interface apenas apresenta resultados.
- Métricas devem declarar unidade, fórmula, escopo e quais tipos de ativos são
  elegíveis. Não aplicar métricas de protocolo indiscriminadamente a tokens.
- Relatórios futuros devem consultar um pacote de evidências versionado, e não
  dados implícitos na UI ou valores sem procedência.

## Lacunas atuais

O produto hoje é um screener de Top 100: preço, market cap, volume e variação
de 24h. Os KPIs globais são estáticos. Derivativos, chains e ETF flows são
placeholders. Há funções de SMA, RSI e MACD no código, mas ainda sem candles
persistidos, endpoint ou apresentação.

## Indicadores-alvo

| Camada | Indicadores |
| --- | --- |
| Mercado | market cap total e por setor, stablecoin supply, dominância BTC/ETH histórica, volume/market cap, breadth e fear & greed |
| Preço/técnico | OHLCV, retornos 1d/7d/30d/90d/YTD, volatilidade, drawdown, SMA/EMA, RSI, MACD, Bollinger e correlação BTC/ETH |
| Tokenomics | circulating supply, FDV, cronograma de supply/unlocks, inflação/emissões, burn/buyback e concentração de holders |
| Fundamentais | TVL, fees, revenue, earnings, DEX/perps volume, usuários/transações, stablecoins e bridge flows |
| On-chain | active addresses, tx count, fees, NVT, realized cap, MVRV, SOPR, exchange flows e cohorts de holders |
| Derivativos | open interest, funding, basis, liquidations, options IV/skew, put/call e OI por strike |
| Institucional/macro | ETF flows/AUM, treasury holdings, juros, DXY, liquidez global e correlação com equities |
| Valuation | MC/TVL, FDV/revenue, MC/fees, EV/revenue, P/S, yield, comparáveis setoriais e cenários bull/base/bear |

## Roadmap

### 1. Fundação de dados

Modelar e persistir `asset`, `metric_definition`, `observation`, `source` e
`coverage`. Criar ingestão agendada, cache, política de retries, qualidade de
dados e metadados obrigatórios para cada leitura.

**Resultado:** séries históricas ponto-no-tempo, pesquisáveis e auditáveis.

### 2. Market data e perfil de ativo — primeiro milestone

Trocar os KPIs estáticos por agregações reais. Criar uma página de detalhe por
ativo com OHLCV, retornos, preço, market cap, FDV, supply e volume, apoiada por
histórico armazenado.

O primeiro conjunto completo deve ser: **BTC, ETH, SOL e HYPE**. HYPE será
tratado explicitamente no modelo de dados e na pesquisa de fontes, incluindo
suas particularidades de supply e tokenomics; não será apenas mais uma linha do
Top 100.

**Resultado:** o produto deixa de ser apenas um terminal de cotações e passa a
oferecer análise histórica confiável dos ativos prioritários.

### 3. Fundamentos e tokenomics

Integrar métricas de protocolos e chains, normalizadas por categoria: L1, L2,
DEX, lending, stablecoin e exchange token. Adicionar unlocks, emissões e
métricas de captura de valor.

### 4. Indicadores derivados e comparáveis

Calcular técnicos e múltiplos no backend. Criar comparáveis por setor, com
histórico dos múltiplos e explicação de fórmulas/denominadores.

### 5. Derivativos, on-chain e ETFs

Conectar as áreas já existentes com dados agregados inicialmente. Cada dado
deve declarar claramente se representa uma exchange, chain, ativo ou mercado
amplo.

### 6. Research e geração de reports

Montar um pacote versionado de evidências por ativo e data de corte: valores,
datas, fórmulas, fontes, cobertura, qualidade e limitações. A geração de
valuation usa esse pacote para produzir análises justificáveis e cenários.

## Sequência de execução aprovada

Começar pelo milestone 2, mas implementar somente o mínimo da fundação do
milestone 1 necessário para sustentá-lo: schema de observações, fonte e
histórico de candles. Depois avançar para fundamentos/tokenomics.

## Critérios de pronto para o primeiro milestone

- BTC, ETH, SOL e HYPE possuem perfil individual acessível na interface.
- Cada perfil mostra séries históricas de OHLCV e retornos calculados.
- Preço, market cap, FDV, supply e volume exibem fonte e horário de observação.
- O backend persiste leituras e pode recalcular indicadores a partir delas.
- Dados ausentes, atrasados ou fora de cobertura aparecem explicitamente.
- Testes cobrem cálculos de retorno/indicadores e contratos dos endpoints.
