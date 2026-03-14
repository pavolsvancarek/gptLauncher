export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return jsonResponse({}, 200);
    }

    try {
      const url = new URL(request.url);

      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }

      if (url.pathname === "/ask") {
        return await handleAsk(request, env);
      }

      if (url.pathname === "/voice") {
        return await handleVoice(request, env);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (e) {
      return jsonResponse({
        error: e?.message || "Server error",
        type: "server_error"
      }, 500);
    }
  }
};

async function handleAsk(request, env) {
  const body = await request.json().catch(() => null);
  const text = (body?.text || "").trim();

  if (!text) {
    return jsonResponse({ error: "Missing text", type: "validation_error" }, 400);
  }

  return await askGptFromText(text, env);
}

async function handleVoice(request, env) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || typeof file === "string") {
    return jsonResponse({ error: "Missing audio file", type: "validation_error" }, 400);
  }

  if (!file.size || file.size < 1024) {
    return jsonResponse({ error: "Audio file is too small", type: "validation_error" }, 400);
  }

  try {
    const transcript = await transcribeAudio(file, env);

    if (!transcript.trim()) {
      return jsonResponse({ error: "Empty transcript", type: "transcription_error" }, 400);
    }

    return await askGptFromText(transcript, env);
  } catch (e) {
    return jsonResponse({
      error: e?.message || "Voice processing failed",
      type: "voice_error"
    }, 500);
  }
}

async function transcribeAudio(file, env) {
  const form = new FormData();
  form.append("file", file, file.name || "audio.m4a");
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("language", "sk");

  const response = await fetchWithRetry(
    "https://api.openai.com/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`
      },
      body: form
    },
    3
  );

  const data = await safeJson(response);

  if (!response.ok) {
    throw new Error(data?.error?.message || `Transcription failed with status ${response.status}`);
  }

  return String(data?.text || "").trim();
}

async function askGptFromText(text, env) {
  const response = await fetchWithRetry(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.4",
        input: [
          {
            role: "developer",
            content: [
              {
                type: "input_text",
                text:
                  "Vráť odpoveď ako JSON s poľami answer a questions. " +
                  "answer je stručná, vecná odpoveď v slovenčine. " +
                  "questions je pole 1 až 5 krátkych otázok v slovenčine."
              }
            ]
          },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text
              }
            ]
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "home_answer",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                answer: { type: "string" },
                questions: {
                  type: "array",
                  minItems: 1,
                  maxItems: 5,
                  items: { type: "string" }
                }
              },
              required: ["answer", "questions"]
            }
          }
        }
      })
    },
    3
  );

  const data = await safeJson(response);

  if (!response.ok) {
    return jsonResponse({
      error: data?.error?.message || "OpenAI request failed",
      type: "openai_error",
      status: response.status
    }, response.status);
  }

  const parsed = extractStructuredJson(data);

  if (!parsed.answer || !Array.isArray(parsed.questions)) {
    return jsonResponse({
      error: "Invalid model output",
      type: "parse_error",
      raw: data
    }, 502);
  }

  return jsonResponse({
    answer: parsed.answer,
    questions: parsed.questions
  });
}

function extractStructuredJson(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    try {
      return JSON.parse(data.output_text);
    } catch {}
  }

  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string" && content.text.trim()) {
        try {
          return JSON.parse(content.text);
        } catch {}
      }

      if (content?.type === "output_text" && typeof content?.text === "string" && content.text.trim()) {
        try {
          return JSON.parse(content.text);
        } catch {}
      }
    }
  }

  return { answer: "", questions: [] };
}

async function safeJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function fetchWithRetry(url, options, maxAttempts = 3) {
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, options);

      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < maxAttempts) {
        await sleep(400 * attempt);
        continue;
      }

      return response;
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        await sleep(400 * attempt);
        continue;
      }
    }
  }

  throw lastError || new Error("Request failed");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-APP-KEY"
    }
  });
}
