// Envio automático do relatório do dia no grupo do WhatsApp.
// Se o servidor estava dormindo ou o WhatsApp caiu no horário, envia assim que puder (até 23:59).
import { diaLocal, horaLocal } from './pedidos.js';
import { textoDoRelatorio } from './resumo.js';

export const PADRAO_RELATORIO = { horario: '18:00', ativo: true, avisarPedido: false };

export async function configRelatorio(banco) {
  return { ...PADRAO_RELATORIO, ...(await banco.ler('relatorio')) };
}

export async function enviarRelatorio({ banco, whatsapp, dia }) {
  const destino = await banco.ler('whatsapp');
  if (!destino?.grupoJid) throw new Error('Crie o grupo do relatório no painel primeiro.');
  const texto = textoDoRelatorio(await banco.listarPedidos(dia), dia);
  await whatsapp.enviar(destino.grupoJid, texto);
  return texto;
}

export function criarAgenda({ banco, whatsapp, log = console, aoMudar = () => {}, intervalo = 30_000 }) {
  let timer = null;
  let rodando = false;
  let pendencia = null;

  async function verificar(agora = new Date()) {
    if (rodando) return;
    rodando = true;
    try {
      const { horario, ativo } = await configRelatorio(banco);
      const dia = diaLocal(agora);
      if (!ativo || horaLocal(agora) < horario || (await banco.relatorioEnviado(dia))) {
        pendencia = null;
        return;
      }
      if (whatsapp.status().estado !== 'conectado') {
        pendencia = 'Relatório de hoje aguardando: o WhatsApp do robô está desconectado.';
        return;
      }
      const texto = await enviarRelatorio({ banco, whatsapp, dia });
      await banco.registrarRelatorio(dia, texto);
      pendencia = null;
      log.info?.(`Relatório de ${dia} enviado.`);
      aoMudar();
    } catch (erro) {
      pendencia = `Relatório de hoje não enviado: ${erro.message}`;
      log.error?.(pendencia);
    } finally {
      rodando = false;
    }
  }

  return {
    verificar,
    pendencia: () => pendencia,
    iniciar() {
      timer = setInterval(() => verificar().catch(() => {}), intervalo);
      timer.unref?.();
    },
    parar() {
      clearInterval(timer);
    },
  };
}
