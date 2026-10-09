# After Os Brothers · Ingressos

Venda de ingressos online (Cloudflare Workers + D1). Fase 1: API completa, pagamento por **Pix por chave com conferência manual**.

## Rodar local
```
npm install
# .dev.vars (não vai pro git): PEPPER=..., QR_SECRET=..., SETUP_KEY=...
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
- Cortesias: admin → aba Cortesias (o e-mail precisa ter conta).
- Migrações novas rodam sozinhas no build (`scripts/aplicar-segredos.mjs`).
- Testes: `npm test` (API) com o servidor local no ar e banco recém-migrado.

## Avisos, senha de desbloqueio e recuperação (fase 3)
- **Resposta secreta**: 1 palavra de 4 a 8 letras, definida no cadastro (ou em *Conta*). Normalizada (sem acento/minúscula), esticada no navegador e guardada só como HMAC. `/auth/recuperar` bloqueia 1 h após 5 erros e avisa o admin a cada uso.
- **Desfazer entrada** (Portaria → Lista): a recepcionista digita a *senha de desbloqueio* (definida em Admin → Avisos); cada uso e cada senha errada geram um aviso ao admin; o ingresso mostra “desfeito N×”. Só funciona online.
- **Avisos**: Admin → Avisos lista os alertas e ativa notificações push (Web Push sem conteúdo; o Service Worker busca o texto em `/api/admin/alertas/pendentes`). Android/Chrome ok; iPhone só com o site instalado na tela inicial.
- **Regras de compra**: `#/regras`; a compra exige marcar o aceite (`aceito_termos`, versão registrada no pedido). Texto é rascunho — vale revisão jurídica.
