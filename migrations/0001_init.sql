-- after-adega-ingressos: esquema inicial.
-- Convenções: valores em CENTAVOS (inteiros); datas em epoch SEGUNDOS (UTC).

CREATE TABLE usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cpf TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  sobrenome TEXT NOT NULL,
  email TEXT NOT NULL,
  telefone TEXT NOT NULL,
  senha_hash TEXT NOT NULL,
  papel TEXT NOT NULL CHECK (papel IN ('admin', 'hostess', 'comprador')),
  ativo INTEGER NOT NULL DEFAULT 1,
  deve_trocar_senha INTEGER NOT NULL DEFAULT 0,
  criado_em INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_usuarios_email ON usuarios (email);

CREATE TABLE sessoes (
  id TEXT PRIMARY KEY,               -- SHA-256 do token (o token em si só existe no cookie)
  usuario_id INTEGER NOT NULL REFERENCES usuarios (id),
  criado_em INTEGER NOT NULL,
  expira_em INTEGER NOT NULL
);
CREATE INDEX idx_sessoes_usuario ON sessoes (usuario_id);

CREATE TABLE tentativas_login (
  cpf TEXT PRIMARY KEY,
  falhas INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate INTEGER NOT NULL DEFAULT 0,
  atualizado_em INTEGER NOT NULL
);

-- "Esqueci minha senha": o pedido chega ao admin, que define uma senha provisória.
CREATE TABLE pedidos_reset (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL REFERENCES usuarios (id),
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'atendido')),
  criado_em INTEGER NOT NULL,
  atendido_em INTEGER,
  atendido_por INTEGER REFERENCES usuarios (id)
);
CREATE INDEX idx_resets_status ON pedidos_reset (status);

CREATE TABLE config (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  data_evento TEXT NOT NULL,         -- AAAA-MM-DD
  local TEXT NOT NULL DEFAULT '',
  descricao TEXT NOT NULL DEFAULT '',
  ativo INTEGER NOT NULL DEFAULT 0,
  criado_em INTEGER NOT NULL
);

CREATE TABLE lotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER NOT NULL REFERENCES eventos (id),
  nome TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  quantidade INTEGER NOT NULL CHECK (quantidade >= 0),
  vendidos INTEGER NOT NULL DEFAULT 0 CHECK (vendidos >= 0),
  reservados INTEGER NOT NULL DEFAULT 0 CHECK (reservados >= 0),
  ativo INTEGER NOT NULL DEFAULT 0,
  ordem INTEGER NOT NULL DEFAULT 0,
  criado_em INTEGER NOT NULL,
  -- Rede de segurança: o banco recusa vender além da quantidade, mesmo se o código falhar.
  CHECK (vendidos + reservados <= quantidade)
);
CREATE INDEX idx_lotes_evento ON lotes (evento_id);

CREATE TABLE pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,       -- código curto mostrado ao comprador (referência do Pix)
  comprador_id INTEGER NOT NULL REFERENCES usuarios (id),
  evento_id INTEGER NOT NULL REFERENCES eventos (id),
  lote_id INTEGER NOT NULL REFERENCES lotes (id),
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  valor_unit_centavos INTEGER NOT NULL,
  subtotal_centavos INTEGER NOT NULL,
  taxa_centavos INTEGER NOT NULL,
  total_centavos INTEGER NOT NULL,
  nome_pagador TEXT NOT NULL,        -- nome que aparecerá no Pix (ajuda na conferência manual)
  forma_pagamento TEXT NOT NULL DEFAULT 'pix_chave',
  status TEXT NOT NULL CHECK (status IN ('aguardando_pagamento', 'pago', 'expirado', 'cancelado')),
  reserva_ativa INTEGER NOT NULL DEFAULT 1,  -- 1 = este pedido segura ingressos em lotes.reservados
  contabilizado INTEGER NOT NULL DEFAULT 0,  -- 1 = já somado em lotes.vendidos
  criado_em INTEGER NOT NULL,
  expira_em INTEGER NOT NULL,
  pago_em INTEGER,
  confirmado_por INTEGER REFERENCES usuarios (id)
);
CREATE INDEX idx_pedidos_status ON pedidos (status, expira_em);
CREATE INDEX idx_pedidos_comprador ON pedidos (comprador_id);
CREATE INDEX idx_pedidos_lote ON pedidos (lote_id);

CREATE TABLE ingressos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER REFERENCES pedidos (id),   -- nulo em cortesias
  evento_id INTEGER NOT NULL REFERENCES eventos (id),
  lote_id INTEGER REFERENCES lotes (id),
  dono_id INTEGER NOT NULL REFERENCES usuarios (id),
  tipo TEXT NOT NULL DEFAULT 'pago' CHECK (tipo IN ('pago', 'cortesia')),
  status TEXT NOT NULL DEFAULT 'valido' CHECK (status IN ('valido', 'usado', 'cancelado')),
  criado_em INTEGER NOT NULL,
  usado_em INTEGER,
  usado_por INTEGER REFERENCES usuarios (id)
);
CREATE INDEX idx_ingressos_dono ON ingressos (dono_id);
CREATE INDEX idx_ingressos_pedido ON ingressos (pedido_id);

CREATE TABLE auditoria (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER REFERENCES usuarios (id),
  acao TEXT NOT NULL,
  detalhe TEXT NOT NULL DEFAULT '',
  criado_em INTEGER NOT NULL
);

-- Valores iniciais. Tudo editável pelo admin depois.
INSERT INTO config (chave, valor) VALUES
  ('taxa_percentual', '10'),
  ('reserva_minutos', '60'),
  ('max_ingressos_por_pedido', '10'),
  ('pix_chave', ''),
  ('pix_nome', ''),
  ('pix_cidade', '');

INSERT INTO eventos (nome, data_evento, local, descricao, ativo, criado_em)
VALUES ('After Os Brothers', '2026-10-23', '', '', 1, strftime('%s', 'now'));
