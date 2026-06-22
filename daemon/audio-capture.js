/**
 * audio-capture.js — WhatsApp voice note capture module
 *
 * This module plugs into a whatsapp-web.js Client and queues incoming voice
 * notes to a local directory so a separate transcription process can pick them
 * up asynchronously.  Works for BOTH incoming messages from other people AND
 * voice notes you forward/send to yourself.
 *
 * Sanitised excerpt — IDs, phone numbers and internal paths have been removed.
 * Full integration lives in the 24/7 daemon that owns the WhatsApp session.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

/**
 * Attach audio capture listeners to a whatsapp-web.js Client.
 *
 * @param {import("whatsapp-web.js").Client} client
 * @param {object} opts
 * @param {string} opts.label       - account label ("personal" | "booking" | …)
 * @param {string} opts.inboxDir    - directory where audio files are queued
 * @param {function} opts.log       - log(msg: string) => void
 */
function attachAudioCapture(client, { label, inboxDir, log }) {
  fs.mkdirSync(inboxDir, { recursive: true });

  /** Queue one voice note to inboxDir/<id>.{ogg,json} */
  async function enqueue(message, origin) {
    try {
      // Only handle voice notes and audio messages
      if (message.type !== "ptt" && message.type !== "audio") return;

      const media = await message.downloadMedia();
      if (!media || !media.data) return;

      // Build metadata: sender name, number, chat name
      let contact = {};
      let chat    = {};
      try { contact = await message.getContact(); } catch (_) {}
      try { chat    = await message.getChat();    } catch (_) {}

      // Sanitise the message ID so it's safe as a filename
      const safeId = (label + "_" + message.id._serialized).replace(/[^a-zA-Z0-9_]/g, "_");

      const meta = {
        acc:        label,
        msgId:      message.id._serialized,
        origin,                                         // "incoming" | "self"
        timestamp:  new Date(message.timestamp * 1000).toISOString(),
        fromName:   origin === "self"
                      ? "Self-forwarded"
                      : (contact.name || contact.pushname || ""),
        fromNumber: origin === "self"
                      ? ""
                      : (contact.number || (message.from || "").split("@")[0]),
        chatName:   chat.name  || "",
        isGroup:    !!chat.isGroup,
      };

      fs.writeFileSync(path.join(inboxDir, safeId + ".ogg"),  Buffer.from(media.data, "base64"));
      fs.writeFileSync(path.join(inboxDir, safeId + ".json"), JSON.stringify(meta, null, 2));

      log(`[${label}] queued ${origin} audio — ${meta.fromName || meta.fromNumber}${meta.isGroup ? " in " + meta.chatName : ""}`);
    } catch (e) {
      log(`[${label}] ERROR enqueue: ${e.message}`);
    }
  }

  // --- Incoming voice notes from OTHER people ---
  client.on("message", (msg) => {
    if (!msg.fromMe) enqueue(msg, "incoming");
  });

  // --- Voice notes you send to your OWN number (self-forward) ---
  //
  // Engineering note: you cannot detect a self-message by comparing msg.from === msg.to.
  // WhatsApp serialises msg.from as <number>@c.us but msg.to as <lid>@lid (the new
  // account-linked identifier), so they will NEVER match even for the same person.
  // The correct check is Contact.isMe on the *destination* contact object.
  client.on("message_create", async (msg) => {
    if (!msg.fromMe) return;
    if (msg.type !== "ptt" && msg.type !== "audio") return;

    let isSelf = false;
    try {
      const dest = await client.getContactById(msg.to);
      isSelf = !!(dest && dest.isMe);
    } catch (_) {}

    // Fallback: number-based check (less reliable with @lid, but kept as safety net)
    if (!isSelf) {
      const fromNum = (msg.from || "").split("@")[0];
      const toNum   = (msg.to   || "").split("@")[0];
      isSelf = (fromNum && fromNum === toNum);
    }

    if (isSelf) enqueue(msg, "self");
  });
}

module.exports = { attachAudioCapture };
