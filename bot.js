import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import fetch from "node-fetch";
import fs from "fs";
import googleTTS from "google-tts-api";

// ============================================================
// VARIÁVEIS DE AMBIENTE
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/82qv379dubrauwe57jhbxx7ofxjgjlzg";
// ============================================================

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const historico = {};

// ── Envia mensagem pro Make e aguarda resposta ────────────────
async function processarViaMake(userId, chatId, texto) {
  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, chatId, texto }),
  });

  if (!res.ok) throw new Error(`Make retornou status ${res.status}`);

  const data = await res.json();
  return data.resposta || null;
}

// ── AssemblyAI: transcreve áudio via URL pública ──────────────
async function transcreverAudio(fileId) {
  const fileInfo = await bot.getFile(fileId);
  const audioUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

  const transcriptRes = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      authorization: ASSEMBLYAI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ audio_url: audioUrl, language_code: "pt", speech_models: ["universal-2"] }),
  });

  const transcriptData = await transcriptRes.json();
  if (transcriptData.error) throw new Error(transcriptData.error);

  const { id } = transcriptData;

  while (true) {
    const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: ASSEMBLYAI_API_KEY },
    });
    const data = await pollRes.json();
    if (data.status === "completed") return data.text;
    if (data.status === "error") throw new Error(data.error);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ── gTTS: converte texto em áudio ─────────────────────────────
async function gerarAudio(texto) {
  const urls = googleTTS.getAllAudioUrls(texto, {
    lang: "pt",
    slow: false,
    host: "https://translate.google.com",
  });

  const chunks = [];
  for (const item of urls) {
    const res = await fetch(item.url);
    const buffer = Buffer.from(await res.arrayBuffer());
    chunks.push(buffer);
  }

  const audioBuffer = Buffer.concat(chunks);
  const outputPath = `/tmp/raylets_resposta_${Date.now()}.mp3`;
  fs.writeFileSync(outputPath, audioBuffer);
  return outputPath;
}

// ── Detecta pedido de resposta em áudio ───────────────────────
function detectaQueroAudio(texto) {
  const frases = [
    "responde em áudio", "responda em áudio", "manda áudio", "me manda um áudio",
    "fala em áudio", "quero áudio", "pode falar", "me fala",
  ];
  return frases.some((f) => texto.toLowerCase().includes(f));
}

function limparArquivo(filePath) {
  try { fs.unlinkSync(filePath); } catch (_) {}
}

// ── Comandos ──────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `Olá, Rayla! 👋 Raylets está pronta.\n\n` +
    `📋 Trello — ver e criar tarefas\n` +
    `📅 Google Calendar — ver agenda e criar eventos\n` +
    `📧 Gmail — resumir e buscar e-mails\n` +
    `📁 Google Drive — buscar arquivos\n` +
    `🎙️ Áudio — manda voz e eu transcrevo e respondo\n\n` +
    `Por padrão respondo em texto. Só pedir pra responder em áudio!`
  );
});

bot.onText(/\/limpar/, (msg) => {
  historico[String(msg.chat.id)] = [];
  bot.sendMessage(msg.chat.id, "🗑️ Histórico apagado!");
});

// ── Listener principal ────────────────────────────────────────
bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  if (!msg.text && !msg.voice) return;

  const userId = String(msg.chat.id);
  const chatId = msg.chat.id;

  // Mensagem de voz
  if (msg.voice) {
    let caminhoAudio = null;
    try {
      await bot.sendChatAction(chatId, "typing");
      const transcricao = await transcreverAudio(msg.voice.file_id);

      await bot.sendMessage(chatId, `🎙️ _Você disse:_ "${transcricao}"`, { parse_mode: "Markdown" });

      await bot.sendChatAction(chatId, "typing");
      const resposta = await processarViaMake(userId, chatId, transcricao);

      if (resposta) {
        await bot.sendChatAction(chatId, "record_voice");
        caminhoAudio = await gerarAudio(resposta);
        await bot.sendVoice(chatId, caminhoAudio);
      }

    } catch (err) {
      console.error("Erro no áudio:", err);
      bot.sendMessage(chatId, "⚠️ Não consegui processar o áudio. Tenta de novo!");
    } finally {
      if (caminhoAudio) limparArquivo(caminhoAudio);
    }
    return;
  }

  // Mensagem de texto
  if (msg.text) {
    const pedindoAudio = detectaQueroAudio(msg.text);
    let caminhoAudio = null;
    try {
      await bot.sendChatAction(chatId, "typing");
      const resposta = await processarViaMake(userId, chatId, msg.text);

      if (!resposta) return;

      if (pedindoAudio) {
        await bot.sendChatAction(chatId, "record_voice");
        caminhoAudio = await gerarAudio(resposta);
        await bot.sendVoice(chatId, caminhoAudio);
      } else {
        bot.sendMessage(chatId, resposta);
      }
    } catch (err) {
      console.error("Erro:", err);
      bot.sendMessage(chatId, "⚠️ Ocorreu um erro. Tenta de novo!");
    } finally {
      if (caminhoAudio) limparArquivo(caminhoAudio);
    }
  }
});

console.log("🤖 Raylets iniciada!");
