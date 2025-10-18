const express = require("express");
const pino = require("pino");
const readline = require("readline");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
  downloadMediaMessage,
} = require("@yumenative/baileys");
const axios = require("axios");
const http = require("http");
const app = express();
app.use(express.json());
const server = http.createServer(app);
const PORT = 4000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || "http://localhost:3000/api/socket/webhook";


async function sendWithTimeout(client, jid, content, timeout = 8000) {
  const send = () =>
    Promise.race([
      client.sendMessage(jid, content),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Send timeout")), timeout)
      ),
    ]);

  try {
    return await send();
  } catch (err) {
    if (
      err.message.includes("timed out") ||
      err.message.includes("Send timeout")
    ) {
      console.warn("⚠️ Send failed, retrying after reconnect...");
      client.ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: { error: err },
      });
      await new Promise((r) => setTimeout(r, 3000));
      return await send();
    }
    throw err;
  }
}

function question(text) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(text, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function startWA() {
  console.log("📱 Starting WhatsApp connection...");

  const store = makeInMemoryStore({
    logger: pino().child({ level: "silent", stream: "store" }),
  });

  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const client = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
  });
  client.ev.on("*", (event, data) => {
    if (event === "messages.upsert") {
      console.log("DEBUG: messages.upsert fired");
    }
  });

  store.bind(client.ev);
  client.ev.on("creds.update", saveCreds);

  client.ev.on("messages.upsert", async (msgUpdate) => {
    const msg = msgUpdate.messages?.[0];
    if (!msg) return;

    const from = msg.key.remoteJid;

    if (from === "status@broadcast" || from.endsWith("@newsletter")) {
      console.log("⏭️ Skipped status/newsletter message:", from);
      return;
    }

    const fromme = msg.key.fromMe || false;
    const user = msg.pushName;

    let type = "text";
    let message = null; 
    let data = null; 
    let mimetype= null; 
    let quoted = null;

    if (msg.message?.conversation) {
      message = msg.message.conversation;

    } else if (msg.message?.extendedTextMessage) {
      message = msg.message.extendedTextMessage.text;

      const ctx = msg.message.extendedTextMessage.contextInfo;
      if (ctx?.quotedMessage) {
        if (ctx.quotedMessage.conversation) {
          quoted = ctx.quotedMessage.conversation;
        } else if (ctx.quotedMessage.extendedTextMessage?.text) {
          quoted = ctx.quotedMessage.extendedTextMessage.text;
        } else if (ctx.quotedMessage.imageMessage?.caption) {
          quoted = ctx.quotedMessage.imageMessage.caption;
        } else if (ctx.quotedMessage.stickerMessage) {
          quoted = "[sticker]";
        } else {
          quoted = "[unsupported message]";
        }
      }

    } else if (msg.message?.imageMessage) {
      type = "image";
      message = msg.message.imageMessage.caption || null;

      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        data = buffer.toString("base64");
        mimetype = msg.message.imageMessage.mimetype || "image/jpeg";
      } catch (err) {
        console.error("❌ Failed to download image:", err);
      }

    } else if (msg.message?.stickerMessage) {
      type = "sticker";
      try {
        const buffer = await downloadMediaMessage(msg, "buffer", {});
        data = buffer.toString("base64");
        mimetype = "image/webp";
      } catch (err) {
        console.error("❌ Failed to download sticker:", err);
      }
    }

    const timestamp =
      msg.messageTimestamp?.low || msg.messageTimestamp || Date.now();

    console.log("📥 Received message:");
    console.log("   Pushname:", user);
    console.log("   From:", from);
    console.log("   Type:", type);
    console.log("   Message:", type === "sticker" ? "[sticker]" : message);
    if (quoted) console.log("   ↪️ Quoted:", quoted);
    console.log("   Timestamp:", timestamp);

    try {
      await axios.post(WEBHOOK_URL, {
        user,
        from,
        type,
        message, 
        data, 
        mimetype,
        quoted,
        timestamp,
        is_from_me: fromme,
      });
      console.log("📤 Forwarded to webhook:", WEBHOOK_URL);
    } catch (err) {
      console.error("⚠️ Failed to forward to webhook:", err.message);
    }
  });

  if (!client.authState.creds.registered) {
    const phoneNumber = await question(
      "/> please enter your WhatsApp number, starting with 62:\n> number: "
    );
    await new Promise((r) => setTimeout(r, 2000));
    const code = await client.requestPairingCode(phoneNumber, "SPMBDIGI");
    console.log(`✅ Your pairing code: ${code}`);
  }
  client.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      if (client.keepAliveInterval) clearInterval(client.keepAliveInterval);
      client.keepAliveInterval = setInterval(async () => {
        try {
          await client.sendPresenceUpdate("available");
          //console.log("💓 Keep-alive ping sent");
        } catch (e) {
          console.warn("⚠️ Keep-alive failed:", e.message);
        }
      }, 120000);

      console.log("✅ Connected successfully");
      await saveCreds();
      console.log("💾 Auth credentials saved.");
      console.log("✅ Ready to send and receive");
    } else if (connection === "close") {
      console.log("❌ Disconnected:", lastDisconnect?.error?.message);
      clearInterval(client.keepAliveInterval);
      startWA();
    }
  });

  app.get("/send-otp", async (req, res) => {
    const rawPhone = req.query.phone || "";
    const phone = rawPhone.replace(/\D/g, "");
    const otp = req.query.otp;
    console.log(phone, otp);
    if (!phone || !otp)
      return res
        .status(400)
        .json({ success: false, message: "Phone and OTP required" });

    if (!client?.user)
      return res
        .status(500)
        .json({ success: false, message: "WhatsApp not connected" });

    try {
      await sendWithTimeout(client, `${phone}@s.whatsapp.net`, {
        text: `Kode OTP kamu adalah: ${otp} jangan bagikan ke siapapun!`,
      });
      res.json({ success: true, message: "OTP sent successfully!" });
    } catch (err) {
      console.error("❌ Failed to send OTP:", err);
      res.status(500).json({ success: false, message: err.message });
    }
  });
  app.use(express.json());

  app.post("/send-message", async (req, res) => {
    const { to, message } = req.body;
    if (!to || !message) {
      return res
        .status(400)
        .json({ success: false, error: "Missing 'to' or 'message'" });
    }

    try {
      const jid = to.includes("@s.whatsapp.net") ? to : `${to}@s.whatsapp.net`;
      const sentMsg = await client.sendMessage(jid, { text: message });

      res.json({
        success: true,
        messageId: sentMsg.key.id,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error("❌ Send error:", err);
      res.status(500).json({
        success: false,
        error: err.message,
        to,
        message,
      });
    }
  });
}

server.listen(PORT, () =>
  console.log(`🚀 WhatsApp OTP service running on port ${PORT}`)
);
startWA();
