# TH das Réguas

Site da barbearia com loja da touca de reflexo, painel de pedidos e relatório diário no WhatsApp.

- **Site** (`/`): o cliente escolhe o produto, a quantidade, retirada na loja ou entrega, e a forma de pagamento. O pedido é salvo e o total é recalculado no servidor com o preço do catálogo.
- **Painel** (`/painel`, com senha), em abas:
  - **Pedidos**: pedidos do dia ao vivo (com som), resumo, situação de cada pedido, histórico por dia.
  - **Relatórios**: qualquer período (7/30 dias, mês, datas livres), gráfico de vendas por dia, por produto, por pagamento, tabela dia a dia, planilha CSV para o Excel e impressão.
  - **Produtos**: nome, detalhe, preço, preço antigo (selo "Promoção"), ativo no site e taxa de entrega.
  - **WhatsApp**: conexão do número do robô por QR Code, grupo com o dono, horário do relatório, aviso opcional a cada pedido e mensagem de teste.
- **Relatório automático**: todo dia no horário escolhido (padrão 18:00, horário de São Luís) o robô envia o resumo no grupo. Se o servidor estava parado ou o WhatsApp caiu no horário, envia assim que voltar (até 23:59), uma vez por dia.

O painel pode ser instalado no celular ("Adicionar à tela inicial").

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
| `DATABASE_URL` | sim, em produção | Postgres. Tabelas criadas sozinhas na primeira subida. |
| `PAINEL_SENHA` | sim | Senha do painel do dono. |
| `SEGREDO_SESSAO` | recomendada | Texto aleatório longo; mantém o dono logado após reinícios. |
| `NODE_ENV` | `production` no Render | Cookie seguro e exige banco. |
| `MANTER_ACORDADO` | `1` no plano gratuito | O serviço se chama a cada 10 min para não dormir (o relatório e o robô dependem disso). |

## Render

Web Service Node (`render.yaml`): build `npm ci`, start `npm start`, health check `/saude`.

- Banco: **Supabase** (plano grátis, região us-east-1). Use o endereço do **Session pooler** (porta 5432): o Render não acessa o endereço direto (só IPv6) e o "Transaction pooler" não mantém a trava do WhatsApp. A Data API do Supabase fica desligada e as tabelas têm RLS ligado (só o sistema lê e grava).
- Troca de banco: defina `MIGRAR_DE` com o endereço do banco antigo e `DATABASE_URL` com o novo; a cada subida o sistema copia os dados, sem duplicar. Depois de conferir, remova `MIGRAR_DE`.
- Em cada deploy a cópia nova só conecta o WhatsApp depois que a antiga sai (trava no Postgres), para a sessão não ser corrompida.

## WhatsApp do robô

1. Chip próprio do robô com WhatsApp instalado.
2. Painel → WhatsApp → **Conectar** → no celular do robô: Aparelhos conectados → Conectar aparelho → ler o QR.
3. Informe o WhatsApp do dono e clique em **Criar grupo com o dono**. Se a privacidade do dono não permitir ser adicionado, o robô manda o link de convite no privado dele.
4. **Mandar teste** confirma que está tudo certo.

A sessão fica no banco (tabela `whatsapp_sessao`); reinícios e deploys não pedem QR de novo. Se o aparelho for removido no celular do robô, o painel avisa para ler o QR outra vez.
