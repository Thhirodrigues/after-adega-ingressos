// Pix "copia e cola" ESTÁTICO (BR Code), com valor e referência (código do pedido).
// O pagamento cai direto na chave do dono, sem gateway e sem taxa de API.

const tlv = (id, valor) => id + String(valor.length).padStart(2, '0') + valor;

// CRC16/CCITT-FALSE (polinômio 0x1021, início 0xFFFF), exigido pelo BR Code.
export function crc16(texto) {
  let crc = 0xffff;
  for (let i = 0; i < texto.length; i++) {
    crc ^= texto.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

const limpar = (s, max) =>
  String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, max);

export function pixCopiaECola({ chave, nome, cidade, valorCentavos, referencia }) {
  const conta = tlv('00', 'br.gov.bcb.pix') + tlv('01', chave);
  const ref = String(referencia).replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  const corpo =
    tlv('00', '01') +
    tlv('26', conta) +
    tlv('52', '0000') +
    tlv('53', '986') +
    tlv('54', (valorCentavos / 100).toFixed(2)) +
    tlv('58', 'BR') +
    tlv('59', limpar(nome, 25) || 'RECEBEDOR') +
    tlv('60', limpar(cidade, 15) || 'SAO PAULO') +
    tlv('62', tlv('05', ref)) +
    '6304';
  return corpo + crc16(corpo);
}
