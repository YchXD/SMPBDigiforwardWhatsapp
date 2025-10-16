const express = require("express");
const pino = require("pino");
const readline = require("readline");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeInMemoryStore,
} = require("@yumenative/baileys");

const app = express();
const PORT = 4000;

// async function sendWithTimeout(client, jid, content, timeout = 8000) {
//   return Promise.race([
//     client.sendMessage(jid, content),
//     new Promise((_, reject) =>
//       setTimeout(() => reject(new Error("Send timeout")), timeout)
//     ),
//   ]);
// }
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

  store.bind(client.ev);
  client.ev.on("creds.update", saveCreds);

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
      // keep session alive interval 2 menit
      if (client.keepAliveInterval) clearInterval(client.keepAliveInterval);
      client.keepAliveInterval = setInterval(async () => {
        try {
          await client.sendPresenceUpdate("available");
          console.log("💓 Keep-alive ping sent");
        } catch (e) {
          console.warn("⚠️ Keep-alive failed:", e.message);
        }
      }, 120000);

      console.log("✅ Connected successfully");

      await saveCreds();
      console.log("💾 Auth credentials saved.");

      setTimeout(async () => {
        try {
          await client.sendPresenceUpdate("available");
          console.log("📶 Presence updated (ready to send)");
        } catch (e) {
          console.warn("⚠️ Could not send presence update:", e.message);
        }
      }, 2000);
      console.log("✅ Ready to send");
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
}

app.listen(PORT, () =>
  console.log(`🚀 WhatsApp OTP service running on port ${PORT}`)
);
startWA();
