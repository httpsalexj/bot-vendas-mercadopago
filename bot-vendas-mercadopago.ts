import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  GuildTextBasedChannel,
  Interaction,
  MessageFlags,
  ModalBuilder,
  Partials,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  ThreadAutoArchiveDuration,
  ThreadChannel,
} from 'discord.js';
import { MercadoPagoConfig, Payment } from 'mercadopago';

/**
 * BOT DE PAINEL DE VENDAS + PIX MERCADO PAGO
 *
 * Instale:
 * npm i discord.js express mercadopago dotenv
 * npm i -D typescript tsx @types/node
 *
 * Execute em dev:
 * npx tsx bot-vendas-mercadopago.ts
 *
 * Variáveis .env:
 * DISCORD_TOKEN=
 * DISCORD_CLIENT_ID=
 * DISCORD_GUILD_ID=
 * SALES_TICKET_CHANNEL_ID=   // canal de texto onde os tópicos privados serão criados
 * LOG_CHANNEL_ID=
 * PAYMENT_RESPONSIBLE_ROLE_ID= // opcional, cargo que pode confirmar recebimento
 * STAFF_ROLE_IDS=123,456      // opcional, cargos adicionados ao tópico
 * MERCADOPAGO_ACCESS_TOKEN=
 * PUBLIC_BASE_URL=https://seu-dominio.com
 * PORT=3000
 * MONTHLY_PRICE=2.5
 *
 * Observações importantes:
 * 1) Para o webhook do Mercado Pago funcionar, PUBLIC_BASE_URL precisa ser público com HTTPS.
 * 2) O exemplo usa email sintético para o payer. Em produção, o ideal é coletar um email real em modal.
 * 3) O canal SALES_TICKET_CHANNEL_ID deve ser um canal de TEXTO normal; o bot criará tópicos privados nele.
 */

type OrderType = 'mensal' | 'patrocinador';
type OrderStatus = 'pending' | 'approved' | 'cancelled' | 'rejected' | 'closed';

interface OrderRecord {
  orderId: string;
  externalReference: string;
  userId: string;
  username: string;
  type: OrderType;
  amount: number;
  threadId: string;
  channelId: string;
  paymentId: string;
  paymentStatus: OrderStatus;
  createdAt: string;
  approvedAt?: string;
  closedAt?: string;
}

const DISCORD_TOKEN = must('DISCORD_TOKEN');
const DISCORD_CLIENT_ID = must('DISCORD_CLIENT_ID');
const DISCORD_GUILD_ID = must('DISCORD_GUILD_ID');
const SALES_TICKET_CHANNEL_ID = must('SALES_TICKET_CHANNEL_ID');
const LOG_CHANNEL_ID = must('LOG_CHANNEL_ID');
const MERCADOPAGO_ACCESS_TOKEN = must('MERCADOPAGO_ACCESS_TOKEN');
const PUBLIC_BASE_URL = must('PUBLIC_BASE_URL');
const PORT = Number(process.env.PORT ?? 3000);
const MONTHLY_PRICE = Number(process.env.MONTHLY_PRICE ?? 2.5);
const PAYMENT_RESPONSIBLE_ROLE_ID = process.env.PAYMENT_RESPONSIBLE_ROLE_ID ?? '';
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS ?? '')
  .split(',')
  .map((v) => v.trim())
  .filter(Boolean);

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'orders.json');

const mpClient = new MercadoPagoConfig({
  accessToken: MERCADOPAGO_ACCESS_TOKEN,
});
const mpPayment = new Payment(mpClient);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

ensureDataFile();

const commands = [
  new SlashCommandBuilder()
    .setName('painelvendas')
    .setDescription('Envia o painel de vendas com Pix Mercado Pago.')
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),
].map((c) => c.toJSON());

client.once(Events.ClientReady, async (ready) => {
  console.log(`✅ Bot online como ${ready.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
    body: commands,
  });
  console.log('✅ Slash commands sincronizados.');

  setInterval(async () => {
    const orders = getOrders().filter((o) => o.paymentStatus === 'pending');
    for (const order of orders) {
      try {
        await syncPaymentStatus(order.paymentId);
      } catch (error) {
        console.error(`Falha ao sincronizar pagamento ${order.paymentId}:`, error);
      }
    }
  }, 60_000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleCommand(interaction);
      return;
    }

    if (interaction.isButton()) {
      await handleButton(interaction);
      return;
    }

    if (interaction.isModalSubmit()) {
      await handleModal(interaction);
      return;
    }
  } catch (error) {
    console.error('Erro ao processar interação:', error);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Ocorreu um erro ao processar sua ação.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }
});

async function handleCommand(interaction: ChatInputCommandInteraction) {
  if (interaction.commandName !== 'painelvendas') return;

  const embed = new EmbedBuilder()
    .setTitle('💰 Painel de Vendas')
    .setDescription(
      [
        'Escolha uma das opções disponíveis abaixo para apoiar ou adquirir seu plano.',
        '',
        '📅 **Pagamento Mensal**',
        'Valor fixo de **R$ 2,60 por mês**.',
        '',
        '⭐ **Patrocinador**',
        'Aceitamos qualquer valor acima de **R$ 1,00**.',
        'Valores menores que **R$ 1,00** não serão aceitos.',
        '',
        '⚠️ **Aviso**',
        'Antes de realizar o pagamento, confira corretamente a opção desejada.',
        '',
        '🙏 Obrigado por apoiar nosso projeto!',
      ].join('\n'),
    )
    .setFooter({ text: 'Ao clicar, será criado um tópico privado de pagamento.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('open_monthly_payment')
      .setLabel('Pagamento Mensal')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('open_sponsor_payment')
      .setLabel('Patrocinador')
      .setStyle(ButtonStyle.Success),
  );

  await interaction.reply({
    content: 'Painel enviado.',
    flags: MessageFlags.Ephemeral,
  });

  await interaction.channel?.send({ embeds: [embed], components: [row] });
}

async function handleButton(interaction: ButtonInteraction) {
  if (interaction.customId === 'open_monthly_payment') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await createOrderFlow(interaction, 'mensal', MONTHLY_PRICE);
    return;
  }

  if (interaction.customId === 'open_sponsor_payment') {
    const modal = new ModalBuilder()
      .setCustomId('sponsor_amount_modal')
      .setTitle('Valor do patrocínio');

    const amountInput = new TextInputBuilder()
      .setCustomId('amount')
      .setLabel('Digite o valor em reais (mínimo R$ 1,00)')
      .setPlaceholder('Ex.: 5, 10.50, 25,00')
      .setRequired(true)
      .setStyle(TextInputStyle.Short);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput));
    await interaction.showModal(modal);
    return;
  }

  if (interaction.customId.startsWith('confirm_receipt:')) {
    const orderId = interaction.customId.split(':')[1];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!canManagePayments(interaction)) {
      await interaction.editReply('Você não tem permissão para confirmar recebimentos.');
      return;
    }

    const order = getOrder(orderId);
    if (!order) {
      await interaction.editReply('Pedido não encontrado.');
      return;
    }

    if (order.paymentStatus !== 'approved') {
      await interaction.editReply('Esse pedido ainda não está aprovado para fechamento.');
      return;
    }

    await finalizeApprovedOrder(order, interaction.user.id);
    await interaction.editReply(`Recebimento confirmado e pedido ${order.orderId} encerrado.`);
    return;
  }
}

async function handleModal(interaction: Interaction) {
  if (!interaction.isModalSubmit()) return;
  if (interaction.customId !== 'sponsor_amount_modal') return;

  const raw = interaction.fields.getTextInputValue('amount');
  const amount = parseBRL(raw);

  if (!amount || amount < 1) {
    await interaction.reply({
      content: 'Valor inválido. Informe um valor igual ou maior que R$ 1,00.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await createOrderFlow(interaction, 'patrocinador', amount);
}

async function createOrderFlow(
  interaction: ButtonInteraction | Interaction,
  type: OrderType,
  amount: number,
) {
  if (!('guild' in interaction) || !interaction.guild) {
    throw new Error('A interação precisa ocorrer em um servidor.');
  }

  const baseChannel = await interaction.guild.channels.fetch(SALES_TICKET_CHANNEL_ID);
  if (!baseChannel || baseChannel.type !== ChannelType.GuildText) {
    throw new Error('SALES_TICKET_CHANNEL_ID precisa ser um canal de texto.');
  }

  const username = normalizeName(interaction.user.username);
  const threadName = `${type === 'mensal' ? 'pagamento-mensal' : 'patrocinador'}-${username}`.slice(0, 100);

  const thread = await baseChannel.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    type: ChannelType.PrivateThread,
    invitable: false,
    reason: `Fluxo de pagamento criado para ${interaction.user.tag}`,
  });

  await thread.members.add(interaction.user.id).catch(() => null);

  for (const roleId of STAFF_ROLE_IDS) {
    await thread.send({ content: `<@&${roleId}> Novo pagamento aberto por <@${interaction.user.id}>.` }).catch(() => null);
  }

  const orderId = crypto.randomUUID();
  const externalReference = `discord-${type}-${orderId}`;

  const payment = await mpPayment.create({
    body: {
      transaction_amount: Number(amount.toFixed(2)),
      description: type === 'mensal' ? 'Plano mensal' : 'Patrocínio',
      payment_method_id: 'pix',
      notification_url: `${PUBLIC_BASE_URL}/mercadopago/webhook`,
      external_reference: externalReference,
      payer: {
        email: `${interaction.user.id}@example.com`,
        first_name: interaction.user.username.slice(0, 80),
      },
    },
  });

  const paymentId = String(payment.id);
  const qrCode = payment.point_of_interaction?.transaction_data?.qr_code ?? '';
  const qrCodeBase64 = payment.point_of_interaction?.transaction_data?.qr_code_base64 ?? '';
  const ticketUrl = payment.point_of_interaction?.transaction_data?.ticket_url ?? '';

  const order: OrderRecord = {
    orderId,
    externalReference,
    userId: interaction.user.id,
    username: interaction.user.tag,
    type,
    amount,
    threadId: thread.id,
    channelId: baseChannel.id,
    paymentId,
    paymentStatus: 'pending',
    createdAt: new Date().toISOString(),
  };

  upsertOrder(order);

  const embed = new EmbedBuilder()
    .setTitle(type === 'mensal' ? '📅 Pagamento Mensal' : '⭐ Patrocínio')
    .setDescription(
      [
        `Olá, <@${interaction.user.id}>! Seu tópico de pagamento foi criado.`,
        '',
        `**Valor:** ${formatBRL(amount)}`,
        `**Pedido:** \`${orderId}\``,
        `**Status:** Pendente`,
        '',
        'Use o Pix abaixo para concluir o pagamento.',
        'Assim que o Mercado Pago confirmar, o bot enviará a validação automaticamente.',
      ].join('\n'),
    );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  if (ticketUrl) {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(ticketUrl).setLabel('Abrir QR Code / Pix no navegador'),
      ),
    );
  }

  const contentParts = [
    `## ${type === 'mensal' ? 'Pagamento Mensal' : 'Patrocínio'}`,
    `**Valor:** ${formatBRL(amount)}`,
    `**Pedido:** ${orderId}`,
    '',
    '**Pix Copia e Cola:**',
    qrCode ? `\`${qrCode}\`` : 'QR Code não retornado pela API.',
  ];

  const files: AttachmentBuilder[] = [];
  if (qrCodeBase64) {
    const buffer = Buffer.from(qrCodeBase64, 'base64');
    files.push(new AttachmentBuilder(buffer, { name: 'qrcode-pix.png' }));
    embed.setImage('attachment://qrcode-pix.png');
  }

  await thread.send({
    content: contentParts.join('\n'),
    embeds: [embed],
    components: rows,
    files,
  });

  await sendLog({
    title: '🆕 Novo pedido criado',
    color: 0x2b8a3e,
    lines: [
      `**Usuário:** <@${interaction.user.id}>`,
      `**Tipo:** ${type}`,
      `**Valor:** ${formatBRL(amount)}`,
      `**Pedido:** \`${orderId}\``,
      `**Payment ID:** \`${paymentId}\``,
      `**Tópico:** <#${thread.id}>`,
    ],
  });

  if ('editReply' in interaction) {
    await interaction.editReply(`Seu tópico foi criado com sucesso: <#${thread.id}>`);
  }
}

async function syncPaymentStatus(paymentId: string) {
  const payment = await mpPayment.get({ id: paymentId });
  const status = mapPaymentStatus(String(payment.status ?? 'pending'));

  const order = getOrders().find((o) => o.paymentId === paymentId);
  if (!order) return;
  if (order.paymentStatus === status) return;

  order.paymentStatus = status;
  if (status === 'approved') {
    order.approvedAt = new Date().toISOString();
  }
  upsertOrder(order);

  const thread = await fetchThread(order.channelId, order.threadId);

  if (status === 'approved') {
    if (thread) {
      await thread.send(`✅ Pagamento aprovado para <@${order.userId}>. Aguardando confirmação final da equipe.`).catch(() => null);
      await closeThreadAccess(thread, order.userId).catch(() => null);
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_receipt:${order.orderId}`)
        .setLabel('Confirmar recebimento')
        .setStyle(ButtonStyle.Success),
    );

    await sendLog({
      title: '✅ Pagamento validado',
      color: 0x1c7ed6,
      lines: [
        `**Usuário:** <@${order.userId}>`,
        `**Tipo:** ${order.type}`,
        `**Valor:** ${formatBRL(order.amount)}`,
        `**Pedido:** \`${order.orderId}\``,
        `**Payment ID:** \`${order.paymentId}\``,
        `**Status Mercado Pago:** approved`,
        `**Tópico:** <#${order.threadId}>`,
      ],
      components: [row],
    });
    return;
  }

  if (thread) {
    await thread.send(`ℹ️ Atualização do pagamento: **${status}**.`).catch(() => null);
  }

  await sendLog({
    title: 'ℹ️ Status de pagamento atualizado',
    color: 0xf08c00,
    lines: [
      `**Usuário:** <@${order.userId}>`,
      `**Pedido:** \`${order.orderId}\``,
      `**Payment ID:** \`${order.paymentId}\``,
      `**Novo status:** ${status}`,
    ],
  });
}

async function finalizeApprovedOrder(order: OrderRecord, confirmedByUserId: string) {
  const thread = await fetchThread(order.channelId, order.threadId);
  if (thread) {
    await thread.delete(`Recebimento confirmado por ${confirmedByUserId}`).catch(() => null);
  }

  order.paymentStatus = 'closed';
  order.closedAt = new Date().toISOString();
  upsertOrder(order);

  const user = await client.users.fetch(order.userId).catch(() => null);
  if (user) {
    await user.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🙏 Obrigado por apoiar nosso projeto!')
          .setDescription(
            [
              `Seu pagamento foi confirmado com sucesso.`,
              '',
              `**Tipo:** ${order.type === 'mensal' ? 'Pagamento Mensal' : 'Patrocinador'}`,
              `**Valor:** ${formatBRL(order.amount)}`,
              '',
              'Agradecemos muito pelo seu apoio 💙',
            ].join('\n'),
          ),
      ],
    }).catch(() => null);
  }

  await sendLog({
    title: '📦 Pedido encerrado',
    color: 0x7048e8,
    lines: [
      `**Usuário:** <@${order.userId}>`,
      `**Pedido:** \`${order.orderId}\``,
      `**Tipo:** ${order.type}`,
      `**Valor:** ${formatBRL(order.amount)}`,
      `**Confirmado por:** <@${confirmedByUserId}>`,
      '**Ação final:** tópico apagado e agradecimento enviado por DM.',
    ],
  });
}

async function closeThreadAccess(thread: ThreadChannel, buyerUserId: string) {
  await thread.members.remove(buyerUserId).catch(() => null);

  const members = await thread.members.fetch().catch(() => null);
  if (members) {
    for (const member of members.values()) {
      if (member.id === client.user?.id) continue;
      if (member.id === buyerUserId) continue;
      const guildMember = await thread.guild.members.fetch(member.id).catch(() => null);
      const isStaff = guildMember
        ? guildMember.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
          guildMember.roles.cache.some((role) => STAFF_ROLE_IDS.includes(role.id) || role.id === PAYMENT_RESPONSIBLE_ROLE_ID)
        : false;

      if (!isStaff) {
        await thread.members.remove(member.id).catch(() => null);
      }
    }
  }

  await thread.setLocked(true).catch(() => null);
  await thread.setArchived(true).catch(() => null);
}

async function fetchThread(channelId: string, threadId: string) {
  const guild = client.guilds.cache.get(DISCORD_GUILD_ID);
  if (!guild) return null;

  const baseChannel = await guild.channels.fetch(channelId).catch(() => null);
  if (!baseChannel || !('threads' in baseChannel)) return null;

  const thread = await (baseChannel as GuildTextBasedChannel).threads.fetch(threadId).catch(() => null);
  return thread ?? null;
}

async function sendLog({
  title,
  color,
  lines,
  components = [],
}: {
  title: string;
  color: number;
  lines: string[];
  components?: ActionRowBuilder<ButtonBuilder>[];
}) {
  const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const embed = new EmbedBuilder().setTitle(title).setColor(color).setDescription(lines.join('\n'));
  await channel.send({ embeds: [embed], components }).catch(() => null);
}

function canManagePayments(interaction: ButtonInteraction) {
  if (!interaction.inCachedGuild()) return false;
  if (interaction.memberPermissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  if (!PAYMENT_RESPONSIBLE_ROLE_ID) return false;
  return interaction.member.roles.cache.has(PAYMENT_RESPONSIBLE_ROLE_ID);
}

function mapPaymentStatus(status: string): OrderStatus {
  switch (status) {
    case 'approved':
      return 'approved';
    case 'cancelled':
      return 'cancelled';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending';
  }
}

function parseBRL(input: string): number | null {
  const normalized = input.replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
}

function formatBRL(value: number) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

function normalizeName(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function must(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Variável ausente: ${name}`);
  return value;
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');
}

function getOrders(): OrderRecord[] {
  ensureDataFile();
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as OrderRecord[];
}

function getOrder(orderId: string) {
  return getOrders().find((o) => o.orderId === orderId) ?? null;
}

function upsertOrder(order: OrderRecord) {
  const orders = getOrders();
  const index = orders.findIndex((o) => o.orderId === order.orderId);
  if (index >= 0) {
    orders[index] = order;
  } else {
    orders.push(order);
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(orders, null, 2), 'utf8');
}

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.status(200).send('Bot de vendas com Mercado Pago online.');
});

app.post('/mercadopago/webhook', async (req, res) => {
  try {
    const paymentId = String(
      req.body?.data?.id ?? req.query['data.id'] ?? req.query.id ?? '',
    );

    if (!paymentId) {
      res.status(200).send('ok');
      return;
    }

    await syncPaymentStatus(paymentId);
    res.status(200).send('ok');
  } catch (error) {
    console.error('Erro no webhook Mercado Pago:', error);
    res.status(500).send('error');
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Webhook HTTP ouvindo na porta ${PORT}`);
});

client.login(DISCORD_TOKEN);
