/**
 * media-selftest.js — active canary for the media download path
 *
 * Why this file exists
 * --------------------
 * The audio pipeline once stayed broken for a full day while every monitor
 * reported green. Text kept flowing, so a "is work still arriving?" check saw
 * traffic and stayed happy. Only voice notes were dead.
 *
 * The lesson is not "add more monitoring". It is that a check which exercises
 * something *similar* to the broken path is worthless. This canary walks the
 * SAME path production walks:
 *
 *   1. take the most recent voice note
 *   2. SERIALISE its message id
 *   3. look the message up again BY THAT ID   <-- this is the step that broke
 *   4. only then download and decrypt
 *
 * Step 3 is the whole point. The first version of this canary skipped it — it
 * grabbed the message model straight from the collection and downloaded the
 * media without ever serialising an id. It passed on both accounts. It would
 * also have reported green throughout the entire outage. It was rewritten
 * before it was ever deployed.
 *
 * Sanitised excerpt — scheduling, alert transport and account wiring removed.
 *
 * Two rules baked into the result contract:
 *
 *   - "No material" is NOT green. If there is no voice note to test with, the
 *     canary reports that it could not run. A silent canary is indistinguishable
 *     from a healthy one, and that confusion is the original bug.
 *
 *   - Report WHICH door it came through (`via`). Green via "rebuilt" means the
 *     minified field was renamed again and the fallback is carrying us — worth
 *     knowing before it breaks completely.
 */

"use strict";

/**
 * Run the canary against a live whatsapp-web.js Client.
 *
 * @param {import("whatsapp-web.js").Client} client
 * @returns {Promise<object>} { ok, bytes, via, ageHours, ... } or { ok:false, reason, detail }
 */
async function runMediaSelftest(client) {
  const started = Date.now();

  const result = await client.pupPage.evaluate(async () => {
    const collections = window.require("WAWebCollections");
    const all = collections.Msg.getModelsArray ? collections.Msg.getModelsArray() : [];
    const audio = all.filter((m) => m && (m.type === "ptt" || m.type === "audio"));

    if (!audio.length) return { reason: "no-material", seen: all.length };

    audio.sort((a, b) => (a.t || 0) - (b.t || 0));
    const candidate = audio[audio.length - 1];
    const out = {
      ageHours: candidate.t ? Math.round((Date.now() / 1000 - candidate.t) / 360) / 10 : null,
    };

    // --- Step 1+2: serialise the id, tolerating minifier renames ---
    const key = candidate.id;
    let msgId = "";
    if (typeof key === "string") {
      msgId = key;
    } else if (key && key._serialized) {
      msgId = key._serialized; out.via = "_serialized";
    } else if (key && key.$1) {
      msgId = key.$1; out.via = "$1";
    } else if (key && key.remote && key.id) {
      const remote = key.remote._serialized ? key.remote._serialized : key.remote;
      msgId = String(!!key.fromMe) + "_" + remote + "_" + key.id; out.via = "rebuilt";
    }
    if (!msgId) {
      out.reason = "cannot-serialise-id";
      out.idKeys = key ? Object.keys(key).slice(0, 10) : null;   // tells us the NEW field name
      return out;
    }

    // --- Step 3: look it up BY THAT ID. This is where it used to explode. ---
    let msg = null;
    try {
      msg = collections.Msg.get(msgId) || null;
      if (!msg) {
        const found = await collections.Msg.getMessagesById([msgId]);
        msg = (found && found.messages && found.messages[0]) || null;
      }
    } catch (e) {
      out.reason = "lookup-by-id";
      out.detail = String(e && e.message ? e.message : e).slice(0, 200);
      return out;
    }
    if (!msg) { out.reason = "lookup-empty"; return out; }

    // --- Step 4: download and decrypt. Bytes are discarded. ---
    out.stage = msg.mediaData && msg.mediaData.mediaStage;
    if (!msg.mediaData) { out.reason = "no-mediaData"; return out; }
    if (msg.mediaData.mediaStage === "REUPLOADING") { out.reason = "media-expired"; return out; }

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
      out.bytes = buffer && buffer.byteLength ? buffer.byteLength : 0;
      return out;
    } catch (e) {
      out.reason = "download";
      out.detail = String(e && e.message ? e.message : e).slice(0, 250);
      return out;
    }
  });

  // "No material" is not success — it means the canary could not sing.
  if (result && result.reason === "no-material") {
    return {
      ok: false,
      reason: "no-material",
      detail: `no voice notes loaded in the store (${result.seen} messages seen); canary could not run`,
    };
  }
  if (!result || result.reason || !result.bytes) {
    return {
      ok: false,
      reason: (result && result.reason) || "empty",
      detail: (result && result.detail) || "download returned no bytes",
      via: result && result.via,
      stage: result && result.stage,
      idKeys: result && result.idKeys,
    };
  }
  return {
    ok: true,
    bytes: result.bytes,
    ms: Date.now() - started,
    ageHours: result.ageHours,
    via: result.via,
    stage: result.stage,
  };
}

module.exports = { runMediaSelftest };
