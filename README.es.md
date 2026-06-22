# WhatsApp Voice Transcriber

> **Audio de WhatsApp → transcripción en tu GPU local → texto de vuelta al self-chat. Sin STT en la nube. 100% privado.**

Pipeline de dos componentes que transcribe automáticamente cada nota de voz que recibís por WhatsApp — y cada memo de voz que te mandás a vos mismo — usando [whisper.cpp](https://github.com/ggerganov/whisper.cpp) en tu propia GPU. El texto transcripto llega de vuelta como un mensaje de WhatsApp en tu self-chat.

---

## Por qué lo construí

Los audios de WhatsApp son el formato dominante de comunicación (especialmente en Latinoamérica). Los problemas:

- **Son un embole escuchar** en reuniones, lugares de silencio o cuando tenés el día apretado.
- **Los servicios de STT en la nube** (Google, Azure, AWS) reciben tu audio — incluyendo conversaciones que querés mantener privadas.
- **La transcripción de WhatsApp** es mediocre y no está disponible en todas las regiones.
- **Los memos de voz que te mandás a vos mismo** no tienen transcripción alguna.

Este sistema resuelve todo con un pipeline que corre en hardware propio, nunca manda audio a servidores externos y funciona 24/7 aunque la PC esté apagada.

---

## Casos de uso

- **Audios de chat**: escuchás el texto en 30 segundos en vez de abrir el audio.
- **Memo de voz propio**: grabás una idea en el auto → el texto aparece en tu self-chat solo.
- **Alimentar LLMs**: dictás en voz alta, copiás el texto transcripto, lo pegás en cualquier IA.
- **Privacidad total**: el audio nunca sale de tu red local.

---

## Arquitectura

```
📱 Audio entrante
    ↓
NUC (24/7) — captura y encola en audio-inbox/
    ↓ (scp vía Tailscale)
PC RTX 3090 — Task Scheduler cada 4 min
    ↓
whisper.cpp large-v3 (GPU, ~3-8s/min audio)
    ↓ (ssh: wa send --b64)
📱 Tu self-chat — texto etiquetado con nombre/grupo/hora
```

---

📖 [Full documentation in English](README.md)
