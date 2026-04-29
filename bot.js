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
// ============================================================

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const historico = {};

// ── Trello ────────────────────────────────────────────────────
async function trelloRequest(method, path, body = null) {
  const url = `https://api.trello.com/1${path}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  return res.json();
}

// ── AssemblyAI: transcreve áudio via URL pública ──────────────
async function transcreverAudio(fileId) {
  // Pega a URL pública do arquivo no Telegram
  const fileInfo = await bot.getFile(fileId);
  const audioUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

  // Solicita transcrição passando a URL diretamente
  const transcriptRes = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: {
      authorization: ASSEMBLYAI_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ audio_url: audioUrl, language_code: "pt" }),
  });

  const transcriptData = await transcriptRes.json();

  if (transcriptData.error) throw new Error(transcriptData.error);

  const { id } = transcriptData;

  // Aguarda o resultado (polling)
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

// ── gTTS: converte texto em áudio (gratuito, sem API key) ─────
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

// ── Tools para o Claude ───────────────────────────────────────
const tools = [
  {
    name: "listar_trello",
    description: "Lista os quadros e cards do Trello. Use quando o usuário perguntar sobre tarefas, projetos ou Trello.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "criar_card_trello",
    description: "Cria um card no Trello. Use quando o usuário pedir para adicionar uma tarefa no Trello.",
    input_schema: {
      type: "object",
      properties: {
        nome_lista: { type: "string", description: "Nome da lista onde criar o card" },
        nome_card: { type: "string", description: "Nome do card" },
        descricao: { type: "string", description: "Descrição opcional do card" },
      },
      required: ["nome_lista", "nome_card"],
    },
  },
];

// ── Executa ferramentas ───────────────────────────────────────
async function executarFerramenta(nome, input) {
  try {
    if (nome === "listar_trello") {
      const boards = await trelloRequest("GET", "/members/me/boards");
      if (!boards || boards.length === 0) return "Nenhum quadro encontrado no Trello.";
      const resultado = [];
      for (const board of boards.slice(0, 3)) {
        const cards = await trelloRequest("GET", `/boards/${board.id}/cards`);
        resultado.push(`\n📋 *${board.name}*`);
        if (!cards || cards.length === 0) {
          resultado.push("  Nenhum card.");
        } else {
          cards.slice(0, 5).forEach((c) => resultado.push(`  - ${c.name}`));
        }
      }
      return resultado.join("\n");
    }

    if (nome === "criar_card_trello") {
      const boards = await trelloRequest("GET", "/members/me/boards");
      let listaEncontrada = null;
      for (const board of boards) {
        const listas = await trelloRequest("GET", `/boards/${board.id}/lists`);
        const lista = listas.find((l) =>
          l.name.toLowerCase().includes(input.nome_lista.toLowerCase())
        );
        if (lista) { listaEncontrada = lista; break; }
      }
      if (!listaEncontrada) return `Lista "${input.nome_lista}" não encontrada. Me diz o nome exato da lista no Trello.`;
      const card = await trelloRequest("POST", "/cards", {
        idList: listaEncontrada.id,
        name: input.nome_card,
        desc: input.descricao || "",
      });
      return `Card "${card.name}" criado na lista "${listaEncontrada.name}"!`;
    }

    return "Ferramenta não reconhecida.";
  } catch (err) {
    console.error(`Erro na ferramenta ${nome}:`, err);
    return `Erro ao executar ${nome}: ${err.message}`;
  }
}

// ── System prompt ─────────────────────────────────────────────
function buildSystemPrompt() {
  const agora = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  return `Você é Raylets, assistente pessoal da Rayla — estratégica, direta e eficiente.
Data e hora atual: ${agora} (horário de Brasília)

Você tem acesso ao Trello para gerenciar tarefas e projetos.

Seu papel é ajudar a Rayla a:
- Organizar prioridades e manter o foco
- Gerenciar tarefas no Trello
- Tirar ideias do papel e transformar em ações concretas
- Dar sugestões práticas e estratégicas

Quando o usuário pedir algo relacionado ao Trello, use as ferramentas disponíveis diretamente.
Responda sempre em português, de forma clara e objetiva.
Quando for responder em áudio, use apenas texto corrido e natural, sem emojis, markdown, asteriscos ou símbolos.`;
}

// ── Detecta pedido de resposta em áudio ───────────────────────
function detectaQueroAudio(texto) {
  const frases = [
    "responde em áudio", "responda em áudio", "manda áudio", "me manda um áudio",
    "fala em áudio", "quero áudio", "pode falar", "me fala",
  ];
  return frases.some((f) => texto.toLowerCase().includes(f));
}

// ── Processa mensagem ─────────────────────────────────────────
async function processarMensagem(userId, texto) {
  if (!historico[userId]) historico[userId] = [];
  historico[userId].push({ role: "user", content: texto });

  let resposta = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: buildSystemPrompt(),
    tools,
    messages: historico[userId].slice(-20),
  });

  while (resposta.stop_reason === "tool_use") {
    const toolUses = resposta.content.filter((b) => b.type === "tool_use");
    const toolResults = [];

    for (const toolUse of toolUses) {
      const resultado = await executarFerramenta(toolUse.name, toolUse.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: resultado,
      });
    }

    historico[userId].push({ role: "assistant", content: resposta.content });
    historico[userId].push({ role: "user", content: toolResults });

    resposta = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      system: buildSystemPrompt(),
      tools,
      messages: historico[userId].slice(-20),
    });
  }

  const textoResposta = resposta.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  if (textoResposta?.trim()) {
    historico[userId].push({ role: "assistant", content: textoResposta });
  }

  if (historico[userId].length > 30) {
    historico[userId] = historico[userId].slice(-30);
  }

  return textoResposta;
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
    `🎙️ Áudio — manda voz e eu transcrevo e respondo\n` +
    `💬 Por padrão respondo em texto. Só pedir pra responder em áudio!`
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

      // Passa o fileId direto, sem baixar o arquivo
      const transcricao = await transcreverAudio(msg.voice.file_id);
      const resposta = await processarMensagem(userId, `[Mensagem de voz]: ${transcricao}`);

      await bot.sendChatAction(chatId, "record_voice");
      caminhoAudio = await gerarAudio(resposta);
      await bot.sendVoice(chatId, caminhoAudio);
      await bot.sendMessage(chatId, `🎙️ _Você disse:_ "${transcricao}"`, { parse_mode: "Markdown" });

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
      const resposta = await processarMensagem(userId, msg.text);

      if (pedindoAudio) {
        await bot.sendChatAction(chatId, "record_voice");
        caminhoAudio = await gerarAudio(resposta);
        await bot.sendVoice(chatId, caminhoAudio);
      } else {
        if (resposta) bot.sendMessage(chatId, resposta);
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
