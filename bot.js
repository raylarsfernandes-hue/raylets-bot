import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import OpenAI from "openai";
import https from "https";
import fs from "fs";

// ============================================================
// VARIÁVEIS DE AMBIENTE — configure no Railway
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
// ============================================================

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Histórico por usuário
const historico = {};

// ── MCP servers conectados ao Claude ─────────────────────────
const MCP_SERVERS = [
  {
    type: "url",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    name: "google-calendar",
  },
  {
    type: "url",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    name: "gmail",
  },
  {
    type: "url",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    name: "google-drive",
  },
];

// ── System prompt ─────────────────────────────────────────────
function buildSystemPrompt() {
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  return `Você é o assistente pessoal da Rayla, estratégico, direto e eficiente.
Data e hora atual: ${agora} (horário de Brasília)

Você tem acesso direto a:
- Google Calendar: ver compromissos, criar e editar eventos
- Gmail: buscar e-mails, criar rascunhos
- Google Drive: buscar e ler arquivos
- Trello: gerenciar tarefas e projetos (use a API do Trello com key=${TRELLO_API_KEY} e token=${TRELLO_TOKEN})

Quando a Rayla pedir algo, execute diretamente usando as ferramentas disponíveis sem pedir confirmação desnecessária.

Seu papel é ajudá-la a:
- Organizar a agenda e compromissos
- Gerenciar e-mails importantes
- Acompanhar projetos no Trello
- Tirar ideias do papel e transformar em ações concretas
- Manter o foco nas prioridades do dia

Seja proativo: antecipe o que ela pode precisar, sugira próximos passos e ajude a executar.
Responda sempre em português, de forma clara e direta.`;
}

// ── Chama a API do Claude com MCP ─────────────────────────────
async function chamarClaude(mensagens) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "mcp-client-2025-04-04",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: buildSystemPrompt(),
      messages: mensagens,
      mcp_servers: MCP_SERVERS,
    }),
  });

  return response.json();
}

// ── Processa mensagem ─────────────────────────────────────────
async function processarMensagem(userId, texto) {
  if (!historico[userId]) historico[userId] = [];
  historico[userId].push({ role: "user", content: texto });

  const mensagens = historico[userId].slice(-20);
  const data = await chamarClaude(mensagens);

  const textoResposta = data.content
    ?.filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n") || "Não consegui processar sua mensagem.";

  if (textoResposta.trim()) {
    historico[userId].push({ role: "assistant", content: textoResposta });
  }

  if (historico[userId].length > 30) {
    historico[userId] = historico[userId].slice(-30);
  }

  return textoResposta;
}

// ── Comandos ──────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Olá, Rayla! 👋 Seu assistente pessoal está pronto.\n\n` +
    `Tenho acesso direto a:\n` +
    `📅 Google Calendar — ver e criar eventos\n` +
    `📧 Gmail — buscar e-mails e criar rascunhos\n` +
    `📁 Google Drive — buscar e ler arquivos\n` +
    `📋 Trello — ver e gerenciar tarefas\n\n` +
    `Você também pode me mandar 🎤 áudios!\n\n` +
    `É só falar o que precisa! 😊`
  );
});

bot.onText(/\/limpar/, (msg) => {
  historico[String(msg.chat.id)] = [];
  bot.sendMessage(msg.chat.id, "🗑️ Histórico apagado!");
});

// ── Áudio ─────────────────────────────────────────────────────
bot.on("voice", async (msg) => {
  const userId = String(msg.chat.id);
  try {
    await bot.sendChatAction(msg.chat.id, "typing");
    const fileUrl = await bot.getFileLink(msg.voice.file_id);
    const audioPath = `/tmp/audio_${userId}.ogg`;

    await new Promise((resolve, reject) => {
      const file = fs.createWriteStream(audioPath);
      https.get(fileUrl, (res) => res.pipe(file).on("finish", resolve).on("error", reject));
    });

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
      language: "pt",
    });

    const texto = transcription.text;
    await bot.sendMessage(msg.chat.id, `🎤 _"${texto}"_`, { parse_mode: "Markdown" });

    const resposta = await processarMensagem(userId, texto);
    if (resposta) bot.sendMessage(msg.chat.id, resposta);

    try { fs.unlinkSync(audioPath); } catch {}
  } catch (err) {
    console.error("Erro no áudio:", err);
    bot.sendMessage(msg.chat.id, "⚠️ Não consegui transcrever o áudio. Tenta de novo!");
  }
});

// ── Texto ─────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/") || msg.voice) return;
  if (!msg.text) return;

  const userId = String(msg.chat.id);
  try {
    await bot.sendChatAction(msg.chat.id, "typing");
    const resposta = await processarMensagem(userId, msg.text);
    if (resposta) bot.sendMessage(msg.chat.id, resposta);
  } catch (err) {
    console.error("Erro:", err);
    bot.sendMessage(msg.chat.id, "⚠️ Ocorreu um erro. Tenta de novo!");
  }
});

console.log("🤖 Assistente da Rayla iniciado!");
