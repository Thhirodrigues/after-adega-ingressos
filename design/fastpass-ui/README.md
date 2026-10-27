# Design de telas — FastPass

Fonte do design das 22 telas do app (visual rave/neon, magenta + ciano, logo FastPass).
Ainda **não é código do app**: é a referência visual para o front que está em `public/`.

## Conteúdo
- `telas/` — uma tela por arquivo `.dc.html` (390×844, celular).
- `canvas.json` — posição das telas no canvas e as abas (Comprador, Amigo que recebe, Hostess, Admin).
- `assets/` — logo FastPass: `logo-icon.png` (só o ingresso com raio) e `logo-full.png` (logo completa), com fundo transparente.

## Telas
| Grupo | Telas |
|---|---|
| Comprador | Página da festa, Entrar, Checkout, Pix, Compra confirmada, Meus ingressos, QR em tela cheia, Transferir, Conta e reembolso |
| Amigo que recebe | Aceitar ingresso, Cadastro rápido |
| Hostess | Login, Scanner, Lista de convidados, Sincronização |
| Admin | Painel, Criar festa, Lotes e preços, Cortesias, Compradores e reembolsos, Equipe, Mercado Pago |

## Como abrir
Os `.dc.html` são componentes do editor de design e precisam do `support.js` dele, que não está aqui.
Num navegador comum a página abre sem estilo de canvas. Para ver as telas, abra o canvas publicado
ou importe estes arquivos num canvas novo do editor.

## Paleta
| Uso | Cor |
|---|---|
| Fundo | `#05060F` |
| Cartões | `#0D1020` |
| Bordas | `#232A4A` |
| Texto | `#F2F6FF` |
| Texto secundário | `#9AA6C9` |
| Magenta (ação principal) | `#FF2BD6` |
| Ciano (destaque) | `#28E0FF` |
| Liberado / pago | `#3DFFA2` |
| Aviso / já usado | `#FFC933` |
| Inválido | `#B3123F` |

Fontes: Unbounded (títulos) e Space Grotesk (texto).

## Pendências do design
- Textos entre colchetes (`[DATA]`, `[ENDEREÇO]`, `[NOME]`) são dados reais a preencher.
- Link de transferência mostra `[dominio]` até o domínio ser definido.
- A logo vem de uma imagem de ~1000px; para uso grande, trocar pelo arquivo original.
