import dotenv from "dotenv";
import mongoose from "mongoose";
import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import * as Sentry from "@sentry/node";

dotenv.config();

Sentry.init({
  dsn: process.env.SENTRY_DSN,
});


const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const chatSchema = new mongoose.Schema({
  chatId: { type: Number, required: true, unique: true },
  step: { type: Number, default: 0 },
  response: { type: Array, default: [] },
});
const Chat = mongoose.model("Chat", chatSchema);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
  } catch (err) {
    Sentry.captureException(err);
    process.exit(1);
  }
};

const promptGPT = async (message) => {
  try {
    const payload = {
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: message },
      ],
      max_tokens: 100,
      temperature: 0.7,
    };

    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      payload,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    Sentry.captureException(err);
    throw new Error("OpenAI request failed.");
  }
};

const initializeChatState = async (chatId) => {
  try {
    let chat = await Chat.findOne({ chatId });
    if (!chat) {
      chat = new Chat({ chatId });
      await chat.save();
    }
    return chat;
  } catch (err) {
    Sentry.captureException(err);
    throw new Error("Failed to initialize chat state.");
  }
};

const incrementChatStateSteps = async (chatId) => {
  try {
    const chat = await Chat.findOne({ chatId });
    if (chat) {
      chat.step += 1;
      await chat.save();
    }
  } catch (err) {
    Sentry.captureException(err);
  }
};

const handleConversationStart = async (chatId, text) => {
  try {
    if (text === "/start") {
      const defaultResponse = "Are you looking for a health insurance plan?";

      const gptResponse = await promptGPT(
        "Ask the user if they are looking for a health insurance plan in a friendly tone."
      );

      await incrementChatStateSteps(chatId);
      bot.sendMessage(chatId, gptResponse || defaultResponse);
    } else {
      const howToStartConversationResponse =
        "Type /start to begin the conversation again.";
      bot.sendMessage(chatId, howToStartConversationResponse);
    }
  } catch (err) {
    Sentry.captureException(err);
    bot.sendMessage(chatId, "An error occurred. Please try again.");
  }
};

const handleConversationContinue = async (chatId, text, state) => {
  try {
    const gptResponse = await promptGPT(
      `User said: ${text}. Continue the conversation.`
    );
    bot.sendMessage(chatId, gptResponse);

    state.response.push({ user: text, bot: gptResponse });
    await state.save();
  } catch (err) {
    Sentry.captureException(err);
    bot.sendMessage(chatId, "An error occurred. Please try again.");
  }
};

const handleConversationFailure = async (chatId) => {
  bot.sendMessage(chatId, "An error occurred. Please try again later.");
};

const handleTelegramMessage = async (message) => {
  const chatId = message.chat.id;
  const text = message.text;

  try {
    const state = await initializeChatState(chatId);

    if (state.step === 0) {
      await handleConversationStart(chatId, text);
    } else {
      await handleConversationContinue(chatId, text, state);
    }
  } catch (err) {
    Sentry.captureException(err);
    handleConversationFailure(chatId);
  }
};

connectDB();

bot.on("message", (message) => {
  handleTelegramMessage(message);
});

process.on("unhandledRejection", (reason) => {
  Sentry.captureException(reason);
});

process.on("uncaughtException", (err) => {
  Sentry.captureException(err);
});
