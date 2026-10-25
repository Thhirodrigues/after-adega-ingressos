# Fast Pass — ingressos

Venda de ingressos online (Cloudflare Workers + D1). Fase 1: API completa, pagamento por **Pix por chave com conferência manual**.

## Rodar local
```
npm install
# Fast Pass — ingressos
npx wrangler d1 migrations apply ingressos --local
npx wrangler dev --local     # http://localhost:8787
npm test                     # com o servidor no ar e banco recém-migrado
```

## Publicar
1. Criar o banco D1 `ingressos` no painel e colocar o `database_id` em `wrangler.jsonc`.
2. Aplicar a migração no banco real: `npx wrangler d1 migrations apply ingressos --remote` (ou colar `migrations/0001_init.sql` no Console do D1).
3. Worker → Settings → Variables and Secrets: `PEPPER`, `QR_SECRET`, `SETUP_KEY` (textos longos e aleatórios; **nunca trocar PEPPER/QR_SECRET depois**, senão senhas e QRs deixam de valer).
4. Push no `main` publica automaticamente.
5. Criar o primeiro admin: `POST /api/setup/admin` com `setup_key` + dados do usuário (só funciona uma vez).
6. No painel admin: configurar chave Pix (telefone precisa de `+55`), favorecido e cidade.

## Senha (para o front)
O navegador deriva a senha antes de enviar: PBKDF2-SHA256, 600.000 iterações, salt `after-adega|v1|<cpf só dígitos>`, 64 hex. O servidor guarda apenas HMAC(PEPPER, ...) disso. O front deve exigir mínimo de 8 caracteres.

## Regras
Valores em centavos; taxa de serviço 10% (configurável); reserva de 60 min; estoque protegido por SQL atômico. QR = `<id>.<32 hex HMAC>`.

## Portaria, transferência e cortesias (fase 2)
- QR do ingresso: `<id>.<versao>.<token>`; a versão sobe a cada transferência e o QR antigo deixa de valer.
- Portaria (`#/portaria`, hostess ou admin): lê o QR pela câmera (jsQR, embutido no site). Online valida no servidor; sem internet confere numa lista de hashes baixada antes e sincroniza depois (conflitos aparecem na tela).
- O site é instalável (PWA) e abre sem internet (`sw.js`).
- Transferência: link de uso único, vale 7 dias, gerado em "Meus ingressos".
- Cortesias por convite nominal: admin → aba Cortesias → "+". Categorias fixas: DJ, aniversariante (nome + nascimento) e amigo/parceiro; o admin define 1 a 4 ingressos. O botão "Enviar pelo WhatsApp" só abre o WhatsApp do admin com a mensagem e o link prontos (envio manual, sem API). O ingresso só nasce quando a pessoa se cadastra/entra com o celular (ou e-mail) informado; convite pendente não vence. O link `#/convite/<token>` não mostra dados da pessoa.
- Portaria pela lista (sem QR): "Dar entrada" pede os 4 últimos números do celular do titular (do convite, enquanto o ingresso está com quem resgatou; da conta do dono atual se foi comprado ou transferido). Exige internet; 3 erros bloqueiam o ingresso por 15 min e avisam o admin. Quem não confirma paga a porta. Convite pendente (quem ainda não criou conta) aparece na lista como "Aguardando cadastro" e também entra pelos 4 últimos números do celular cadastrado no convite: os ingressos nascem já usados, em nome do convidado, e o convite fecha quando todos entram (entrada parcial deixa o resto pendente; se a pessoa se cadastrar depois, só nascem os ingressos que faltam). Exige internet.
- Cortesia por cupom VIP: o limite de ingressos do cupom é definido no cadastro dele (Lotes e cupons).
- Migrações novas rodam sozinhas no build (`scripts/aplicar-segredos.mjs`).
- Testes: `npm test` (API) com o servidor local no ar e banco recém-migrado.

## Avisos, senha de desbloqueio e recuperação (fase 3)
- **Resposta secreta**: 1 palavra de 4 a 8 letras, definida no cadastro (ou em *Conta*). Normalizada (sem acento/minúscula), esticada no navegador e guardada só como HMAC. `/auth/recuperar` bloqueia 1 h após 5 erros e avisa o admin a cada uso.
- **Desfazer entrada** (Portaria → Lista): a recepcionista digita a *senha de desbloqueio* (definida em Admin → Avisos); cada uso e cada senha errada geram um aviso ao admin; o ingresso mostra “desfeito N×”. Só funciona online.
- **Avisos**: Admin → Avisos lista os alertas e ativa notificações push (Web Push sem conteúdo; o Service Worker busca o texto em `/api/admin/alertas/pendentes`). Android/Chrome ok; iPhone só com o site instalado na tela inicial.
- **Regras de compra**: `#/regras`; a compra exige marcar o aceite (`aceito_termos`, versão registrada no pedido). Texto é rascunho — vale revisão jurídica.

## Fase 4: pedidos, CSV e textos legais
- **Reserva de 20 minutos** (migração `0005` ajusta `reserva_minutos`); **um pedido em aberto por pessoa** (409 com `pedido_aberto`). Pagar ou cancelar libera.
- **Aviso e push a cada novo pedido** (`novo_pedido`).
- **CSV** (Admin → Financeiro/Pedidos): `/api/admin/export/convidados.csv` (sem CPF, para imprimir) e `/api/admin/export/vendas.csv`. Separador `;`, BOM para o Excel, células neutralizadas contra fórmula.
- **Termos de uso / regras de compra (`#/regras`) e Política de Privacidade (`#/privacidade`)**; o cadastro exige aceite (`aceito_termos`, versão e hora gravadas em `usuarios`). Contato da organização editável em Admin → Pix e taxas. Textos são rascunho: revisar com advogado. Versão em `src/lib/termos.js` e `TERMOS_VERSAO` no `app.js` (mudar os dois juntos).
- Reembolso por Pix manual em até 2 dias úteis após a festa (nas regras).

## Fase 5 — venda presencial e seletor de quantidade

- **Venda na porta**: aba **Venda** na Portaria (hostess e admin). Registra dinheiro ou Pix, sem taxa de serviço, com um campo de nome para cada ingresso; a entrada é marcada na hora e não gera QR. Venda antecipada é só online. Exige internet (estoque decidido no servidor, atômico).
- **Lotes por canal** (Admin → Lotes): "Online e na porta", "Só online" ou "Só na porta" (lote só-porta nunca aparece no site).
- Admin pode confirmar um pedido online como **"Recebi em dinheiro"**.
- Financeiro: quadro por forma de pagamento e **por vendedor** (prestação de contas do dinheiro).
- CSV de vendas ganhou colunas Canal e Forma; lista da porta mostra nomes de convidados avulsos.
- Quantidade agora usa botões − / + (home e tela de compra).
- Regras/termos na versão `2026-10-v3` (menciona venda presencial); migração `0006`.

## Fase 6 — Mercado Pago (Checkout Pro)

- Tela do pedido ganha **"Pagar com cartão ou Pix"** (só aparece com `MP_ACCESS_TOKEN` cadastrado). O servidor cria a preferência (valor = total do pedido, sem boleto, cartão só à vista, expira junto com a reserva) e o comprador paga no Mercado Pago.
- **Webhook** `POST /api/mp/webhook`: confere `x-signature` (se `MP_WEBHOOK_SECRET` existir), **re-consulta o pagamento na API**, confere moeda e valor, grava o `mp_payment_id` (único) e confirma o pedido uma vez só (forma `mercadopago`). Pagamento sem estoque ou valor diferente geram aviso ao admin. **Estorno total no Mercado Pago cancela o pedido e invalida os ingressos automaticamente** (se algum já foi usado na portaria, nada é cancelado e o admin é avisado). **Chargeback só avisa**: o admin decide se cancela.
- O Pix pela chave continua como alternativa (confirmação manual).
- Segredos no Worker (Settings → Variables and secrets, tipo Secret): `MP_ACCESS_TOKEN` e `MP_WEBHOOK_SECRET`. Webhook no painel do MP: `https://<site>/api/mp/webhook`, evento Pagamentos.
- Testes: `MP_TEST=1` com `wrangler dev --var MP_ACCESS_TOKEN:teste --var MP_API_BASE:http://localhost:9911 --var MP_WEBHOOK_SECRET:segredo-mp` (o teste sobe um Mercado Pago falso). Migração `0007`.

## Fase 7 — cupons e painel de Pagamentos

- **Cupom**: campo "Cupom" na tela de compra, antes de efetuar a compra (só o rótulo, sem mensagem). Admin → Lotes → **Cupons**: palavra-chave (sem acento/espaço, maiúsculas), benefício (**sem taxa de serviço**, **desconto %** no valor dos ingressos ou **VIP**), limite de ingressos (vazio = sem limite) e ativo/inativo. Vale só para pedidos novos.
- Desconto % sai do valor dos ingressos e a taxa de serviço incide sobre o que sobra. **VIP** (ou qualquer cupom que zere o total): o pedido já nasce pago e os ingressos saem como **cortesia** com o motivo "Cupom <palavra>". O limite do cupom conta ingressos de pedidos pagos + reservas em aberto e é conferido de forma atômica na criação do pedido.
- Cupom errado/desativado/esgotado devolve sempre a mesma mensagem; 5 erros em 10 min bloqueiam novas tentativas (contra adivinhar palavra VIP).
- Financeiro: seção **Pagamentos** com os cards Recebido, Aguardando pagamento, Por Pix e Por cartão (cartão/Pix do Mercado Pago vêm do `payment_type_id` do webhook). Taxa de serviço e descontos de cupom ficam numa linha discreta abaixo. CSV de vendas ganhou Desconto e Cupom. Migração `0008`.
