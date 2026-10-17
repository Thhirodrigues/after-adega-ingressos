-- Arquivos do app editáveis pelo admin (hoje só o flyer da tela de agradecimento).
CREATE TABLE arquivos (
  nome TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,
  dados BLOB NOT NULL,
  atualizado_em INTEGER NOT NULL
);
