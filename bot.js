import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import fs from "fs";

// ============================================================
// CONFIGURAÇÃO — coloque suas chaves aqui
// ============================================================
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// ============================================================

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Arquivos de persistência
const TASKS_FILE = "tasks.json";
const REMINDERS_FILE = "reminders.json";

// Memória de conversa por usuário (mantida em RAM)
const historico = {};

// ── Helpers de persistência ──────────────────────────────────
function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

let tasks = loadJSON(TASKS_FILE); // { userId: [ {id, text, done} ] }
let reminders = loadJSON(REMINDERS_FILE); // { userId: [ {id, text, time} ] }

// ── Sistema de lembretes ─────────────────────────────────────
function checkReminders() {
  const now = new Date();
  for (const userId in reminders) {
    reminders[userId] = reminders[userId].filter((r) => {
      const reminderTime = new Date(r.time);
      if (reminderTime <= now) {
        bot.sendMessage(userId, `⏰ *Lembrete:* ${r.text}`, {
          parse_mode: "Markdown",
        });
        return false; // remove após disparar
      }
      return true;
    });
  }
  saveJSON(REMINDERS_FILE, reminders);
}

// Verifica lembretes a cada minuto
setInterval(checkReminders, 60_000);

// ── Comandos rápidos ─────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "você";
  bot.sendMessage(
    msg.chat.id,
    `Olá, ${name}! 👋 Sou seu assistente pessoal.\n\n` +
      `Posso te ajudar com:\n` +
      `📋 /tarefas — ver suas tarefas\n` +
      `✅ /feita <número> — marcar tarefa como concluída\n` +
      `⏰ /lembretes — ver seus lembretes\n` +
      `🗑️ /limpar — apagar histórico da conversa\n\n` +
      `Ou simplesmente me manda uma mensagem! 😊`
  );
});

bot.onText(/\/tarefas/, (msg) => {
  const userId = String(msg.chat.id);
  const lista = tasks[userId] || [];
  if (lista.length === 0) {
    return bot.sendMessage(msg.chat.id, "📋 Nenhuma tarefa por enquanto!");
  }
  const texto = lista
    .map((t, i) => `${i + 1}. ${t.done ? "✅" : "⬜"} ${t.text}`)
    .join("\n");
  bot.sendMessage(msg.chat.id, `📋 *Suas tarefas:*\n${texto}`, {
    parse_mode: "Markdown",
  });
});

bot.onText(/\/feita (\d+)/, (msg, match) => {
  const userId = String(msg.chat.id);
  const index = parseInt(match[1]) - 1;
  if (tasks[userId]?.[index]) {
    tasks[userId][index].done = true;
    saveJSON(TASKS_FILE, tasks);
    bot.sendMessage(
      msg.chat.id,
      `✅ Tarefa "${tasks[userId][index].text}" marcada como concluída!`
    );
  } else {
    bot.sendMessage(msg.chat.id, "❌ Número de tarefa inválido.");
  }
});

bot.onText(/\/lembretes/, (msg) => {
  const userId = String(msg.chat.id);
  const lista = reminders[userId] || [];
  if (lista.length === 0) {
    return bot.sendMessage(msg.chat.id, "⏰ Nenhum lembrete agendado!");
  }
  const texto = lista
    .map((r, i) => `${i + 1}. ${r.text} — ${new Date(r.time).toLocaleString("pt-BR")}`)
    .join("\n");
  bot.sendMessage(msg.chat.id, `⏰ *Seus lembretes:*\n${texto}`, {
    parse_mode: "Markdown",
  });
});

bot.onText(/\/limpar/, (msg) => {
  const userId = String(msg.chat.id);
  historico[userId] = [];
  bot.sendMessage(msg.chat.id, "🗑️ Histórico da conversa apagado!");
});

// ── Mensagens livres → Claude ────────────────────────────────
bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return; // ignora comandos

  const userId = String(msg.chat.id);
  const texto = msg.text;

  if (!historico[userId]) historico[userId] = [];
  historico[userId].push({ role: "user", content: texto });

  // Contexto atual de tarefas e lembretes para o Claude
  const tarefasAtivas = (tasks[userId] || [])
    .filter((t) => !t.done)
    .map((t, i) => `${i + 1}. ${t.text}`)
    .join("\n") || "Nenhuma";

  const lembretesAtivos = (reminders[userId] || [])
    .map((r, i) => `${i + 1}. ${r.text} em ${new Date(r.time).toLocaleString("pt-BR")}`)
    .join("\n") || "Nenhum";

  const systemPrompt = `Você é um assistente pessoal eficiente e simpático, integrado ao Telegram.

Você pode ajudar o usuário com:
1. **Tarefas (to-do):** Se o usuário pedir para adicionar uma tarefa, responda EXATAMENTE neste formato JSON (e nada mais além do JSON + sua mensagem):
   {"action":"add_task","text":"descrição da tarefa"}
   
2. **Lembretes:** Se o usuário pedir um lembrete com data/hora, responda com:
   {"action":"add_reminder","text":"descrição","time":"ISO8601"}
   Use o fuso horário de Brasília (UTC-3). Data de hoje: ${new Date().toLocaleDateString("pt-BR")}, horário atual: ${new Date().toLocaleTimeString("pt-BR")}.
   
3. **Resumos:** Resuma textos de forma clara e objetiva.
4. **Respostas gerais:** Responda qualquer pergunta de forma útil e direta.

Estado atual do usuário:
- Tarefas pendentes: ${tarefasAtivas}
- Lembretes ativos: ${lembretesAtivos}

Se for uma ação (add_task ou add_reminder), coloque o JSON na PRIMEIRA linha, depois uma mensagem amigável confirmando.
Para todo o resto, responda normalmente em português.`;

  try {
    await bot.sendChatAction(msg.chat.id, "typing");

    const resposta = await client.messages.create({
     model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: historico[userId],
    });

    const conteudo = resposta.content[0].text;

    // Verifica se tem ação JSON na resposta
    const primeiraLinha = conteudo.split("\n")[0].trim();
    let mensagemFinal = conteudo;

    try {
      const acao = JSON.parse(primeiraLinha);

      if (acao.action === "add_task" && acao.text) {
        if (!tasks[userId]) tasks[userId] = [];
        tasks[userId].push({ id: Date.now(), text: acao.text, done: false });
        saveJSON(TASKS_FILE, tasks);
        mensagemFinal = conteudo.split("\n").slice(1).join("\n").trim();
      }

      if (acao.action === "add_reminder" && acao.text && acao.time) {
        if (!reminders[userId]) reminders[userId] = [];
        reminders[userId].push({ id: Date.now(), text: acao.text, time: acao.time });
        saveJSON(REMINDERS_FILE, reminders);
        mensagemFinal = conteudo.split("\n").slice(1).join("\n").trim();
      }
    } catch {
      // Não era JSON, resposta normal
    }

    if (conteudo) historico[userId].push({ role: "assistant", content: conteudo });

    // Limita histórico a 20 mensagens para não estourar contexto
    if (historico[userId].length > 20) {
      historico[userId] = historico[userId].slice(-20);
    }

    bot.sendMessage(msg.chat.id, mensagemFinal || conteudo);
  } catch (err) {
    console.error("Erro:", err);
    bot.sendMessage(
      msg.chat.id,
      "⚠️ Ocorreu um erro ao processar sua mensagem. Tente novamente."
    );
  }
});

console.log("🤖 Bot iniciado! Aguardando mensagens...");