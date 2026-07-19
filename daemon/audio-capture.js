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
 * Serialise a WhatsApp MsgKey, tolerating minifier renames.
 *
 * WhatsApp Web stopped exposing `_serialized` on message keys. The equivalent
 * field is now called `$1` — a name produced by the minifier, which means it
 * can become `$2` in any future build. So `$1` is only a shortcut here: the
 * last resort rebuilds the same string from the three stable fields.
 *
 *   { fromMe: false, remote: "<id>@lid", id: "<HEX>", $1: "false_<id>@lid_<HEX>" }
 *
 * Depending on `_serialized` alone is what silently broke media downloads:
 * the library kept reading the old name, got `undefined`, and handed that to
 * IndexedDB, which answered "No key or key range specified".
 */
function serialiseMsgKey(key) {
  if (!key) return "";
  if (typeof key === "string") return key;
  if (key._serialized) return key._serialized;
  if (key.$1) return key.$1;
  const remote = key.remote && key.remote._serialized ? key.remote._serialized : key.remote;
  if (remote && key.id) return String(!!key.fromMe) + "_" + remote + "_" + key.id;
  return "";
}

/**
 * Download media for a message without going through Message.downloadMedia().
 *
 * The library's own implementation reads `this.id._serialized` internally, so
 * fixing the ID on our side is not enough — the broken read happens inside it.
 * This mirrors its logic but passes an ID produced by serialiseMsgKey().
 *
 * Patching node_modules would have been a one-line fix and was rejected: an
 * `npm install` erases it silently, and the resulting failure looks exactly
 * like this one — dead audio, no usable error.
 */
async function downloadMedia(client, message) {
  const msgId = serialiseMsgKey(message.id);
  if (!msgId) throw new Error("could not serialise message id");

  const result = await client.pupPage.evaluate(async (id) => {
    const collections = window.require("WAWebCollections");
    let msg = collections.Msg.get(id);
    if (!msg) {
      const found = await collections.Msg.getMessagesById([id]);
      msg = found && found.messages && found.messages[0];
    }
    if (!msg || !msg.mediaData) return { error: "message has no mediaData" };
    if (msg.mediaData.mediaStage === "REUPLOADING") return { error: "media expired" };

    if (msg.mediaData.mediaStage !== "RESOLVED") {
      try {
        await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
      } catch (e) {
        return { error: "resolve failed: " + String(e && e.message).slice(0, 150) };
      }
    }
    const stage = msg.mediaData.mediaStage || "";
    if (stage.includes("ERROR") || stage === "FETCHING") return { error: "mediaStage=" + stage };

    // The download manager expects a QPL tracer (Meta's internal profiler).
    // A no-op stub satisfies it without pulling in the real one.
    const qplStub = { addAnnotations() { return this; }, addPoint() { return this; } };
    try {
      const buffer = await window.require("WAWebDownloadManager").downloadManager.downloadAndMaybeDecrypt({
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: msg.type,
        signal: new AbortController().signal,
        downloadQpl: qplStub,
      });
      return { data: await window.WWebJS.arrayBufferToBase64Async(buffer), mimetype: msg.mimetype };
    } catch (e) {
      return { error: "download/decrypt: " + String(e && e.message ? e.message : e).slice(0, 200) };
    }
  }, msgId);

  if (!result || result.error) throw new Error((result && result.error) || "no result");
  return result;
}

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

      const media = await downloadMedia(client, message);
      if (!media || !media.data) return;

      // Build metadata: sender name, number, chat name
      let contact = {};
      let chat    = {};
      try { contact = await message.getContact(); } catch (_) {}
      try { chat    = await message.getChat();    } catch (_) {}

      // Sanitise the message ID so it's safe as a filename
      const safeId = (label + "_" + serialiseMsgKey(message.id)).replace(/[^a-zA-Z0-9_]/g, "_");

      const meta = {
        acc:        label,
        msgId:      serialiseMsgKey(message.id),
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

module.exports = { attachAudioCapture, serialiseMsgKey, downloadMedia };
