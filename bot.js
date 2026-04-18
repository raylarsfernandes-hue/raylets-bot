import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";
import fetch from "node-fetch";

// ============================================================
// VARIÁVEIS DE AMBIENTE
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TRELLO_API_KEY = process.env.TRELLO_API_KEY;
const TRELLO_TOKEN = process.env.TRELLO_TOKEN;
// ============================================================

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Histórico por usuário
const historico = {};

// ── Trello ────────────────────────────────────────────────────
async function trelloRequest(method, path, body = null) {
  const url = `https://api.trello.com/1${path}?key=${TRELLO_API_KEY}&token=${TRELLO_TOKEN}`;
  const options = { method, headers: { "Content-Type": "application/json" } };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(url, options);
  return res.json();
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
      return `✅ Card "${card.name}" criado na lista "${listaEncontrada.name}"!`;
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
  return `Você é o assistente pessoal da Rayla, estratégico, direto e eficiente.
Data e hora atual: ${agora} (horário de Brasília)

Você tem acesso ao Trello para gerenciar tarefas e projetos.

Seu papel é ajudar a Rayla a:
- Organizar prioridades e manter o foco
- Gerenciar tarefas no Trello
- Tirar ideias do papel e transformar em ações concretas
- Dar sugestões práticas e estratégicas

Quando o usuário pedir algo relacionado ao Trello, use as ferramentas disponíveis diretamente.
Responda sempre em português, de forma clara e objetiva.`;
}

// ── Processa mensagem ─────────────────────────────────────────
async function processarMensagem(userId, texto) {
  if (!historico[userId]) historico[userId] = [];
  historico[userId].push({ role: "user", content: texto });

  const mensagens = historico[userId].slice(-20);

  let resposta = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: buildSystemPrompt(),
    tools,
    messages: mensagens,
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

  if (textoResposta && textoResposta.trim()) {
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
    `Posso te ajudar com:\n` +
    `📋 Trello — ver e criar tarefas\n` +
    `💬 Conversas estratégicas — organizar ideias e prioridades\n\n` +
    `É só falar o que precisa! 😊`
  );
});

bot.onText(/\/limpar/, (msg) => {
  historico[String(msg.chat.id)] = [];
  bot.sendMessage(msg.chat.id, "🗑️ Histórico apagado!");
});

// ── Mensagens de texto ────────────────────────────────────────
bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
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
