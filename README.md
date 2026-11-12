# TH das Réguas

Site da barbearia com loja da touca de reflexo, painel de pedidos e relatório diário no WhatsApp.

- **Site** (`/`): o cliente monta o pedido (nome, WhatsApp, quantidade, pagamento, retirada ou entrega). O pedido é salvo e o preço é recalculado no servidor.
- **Painel** (`/painel`): pedidos do dia ao vivo, resumo (clientes, toucas, total, pagamento, retirada/entrega), situação de cada pedido, histórico por dia.
- **Relatório**: todo dia no horário escolhido (padrão 18:00, horário de São Luís) o número do robô envia o resumo num grupo com o dono. Se o servidor estava parado ou o WhatsApp caiu no horário, envia assim que voltar (até 23:59), uma vez por dia.

## Rodar local

```bash
npm install
PAINEL_SENHA=uma-senha npm start   # http://localhost:3000 e /painel
npm test
```

Sem `DATABASE_URL` os dados ficam em memória (somem ao reiniciar).

## Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | sim, em produção | Postgres (Supabase/Neon). Tabelas criadas sozinhas na primeira subida. |
| `PAINEL_SENHA` | sim | Senha do painel do dono. |
| `SEGREDO_SESSAO` | recomendada | Texto aleatório longo; mantém o dono logado após reinícios. |
| `NODE_ENV` | `production` no Render | Cookie seguro e exige banco. |

## Render

- Tipo: **Web Service** (Node). Build `npm ci`, start `npm start`, health check `/saude`.
- O plano gratuito dorme após 15 min sem acesso: o primeiro cliente espera ~50 s e o WhatsApp desconecta até alguém acessar. Para pedidos e relatório confiáveis use o plano pago (Starter), ou um monitor externo chamando `/saude` a cada 10 min.

## WhatsApp do robô

1. Chip próprio do robô com WhatsApp instalado.
2. Painel → **Conectar** → no celular do robô: Aparelhos conectados → Conectar aparelho → ler o QR.
3. Informe o WhatsApp do dono e clique em **Criar grupo com o dono**.

A sessão fica no banco (tabela `whatsapp_sessao`); reinícios e deploys não pedem QR de novo. Se o aparelho for removido no celular, o painel avisa para ler o QR outra vez.
