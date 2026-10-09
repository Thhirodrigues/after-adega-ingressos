# after-adega-ingressos

Venda de ingressos das festas da Os Brothers Adega (projeto separado do Caderninho Digital).

## Estado atual: TESTE TÉCNICO (spike)

Antes de construir o app, este código responde duas perguntas sobre o plano grátis do
Cloudflare Workers (limite de 10 ms de CPU por requisição):

1. O hash de senha do login (PBKDF2) cabe no limite? Com quantas iterações?
2. A criação de um Pix no Mercado Pago funciona a partir do Worker?

Resultado define o caminho: Cloudflare Workers, ou plano B (Render grátis + TiDB).

## Como rodar o teste (pelo painel do Cloudflare, sem terminal)

1. Crie uma conta no Cloudflare só para este projeto.
2. *Workers & Pages* → *Create* → *Import a repository* → escolha `after-adega-ingressos`
   (autorize o app do GitHub apenas para este repositório) → *Save and Deploy*.
3. Abra a URL `https://after-adega-ingressos.<sua-conta>.workers.dev`. A página tem links
   de teste: toque em **um por vez**, do menor para o maior.
4. No painel: *Workers & Pages* → seu worker → *Metrics* → olhe **CPU Time** (p50 e p99).
   Anote também se algum link retornou erro e qual mensagem.

### Teste do Pix (opcional, só depois do teste de senha)

Em *Settings → Variables and Secrets*, crie dois **Secrets**:

- `MP_ACCESS_TOKEN`: use o token de **teste** do Mercado Pago, nunca o de produção.
- `SPIKE_KEY`: uma senha qualquer que você inventar.

Depois abra `/spike/pix?key=SUA_SPIKE_KEY&valor=1`. O teste cria um Pix pendente de R$ 1,00
e **não deve ser pago**.

## Rodar localmente

```bash
npm install
npx wrangler dev --local
```

Localmente não existe o limite de 10 ms, então só serve para ver se o código funciona.
O teste que vale é o do Cloudflare.
