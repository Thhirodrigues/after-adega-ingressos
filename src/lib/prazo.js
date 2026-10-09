// Início da festa em epoch (segundos). O Brasil não tem horário de verão desde 2019,
// então São Paulo é sempre UTC-3.
export function inicioDoEvento(data, hora = '22:00') {
  const [a, m, d] = String(data).split('-').map(Number);
  const [h, mi] = String(hora).split(':').map(Number);
  return Math.floor(Date.UTC(a, m - 1, d, h || 0, mi || 0) / 1000) + 3 * 3600;
}

export const limiteTransferencia = (data, hora, horasAntes) => inicioDoEvento(data, hora) - Number(horasAntes) * 3600;

export const formatarSP = (epoch) =>
  new Date(epoch * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
