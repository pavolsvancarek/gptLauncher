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
  if (file.size > 10 * 1024 * 1024) {
    return jsonResponse({ error: "Audio file too large" }, 413);
  }
  
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

const safeTranscript = transcript.slice(0, 10000);

  return await askGptFromText(safeTranscript, env);
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
                  "Z textu vytvor JEDNU krátku otázku v slovenčine, ktorá vystihuje hlavnú myšlienku. " +
                  "Max 120 znakov. Bez vysvetlenia. Len otázka. Vráť JSON {question}."        
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
                question: {
                  type: "string",
                  maxLength: 120
                }
              },
              required: ["question"]
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

if (!parsed.question || typeof parsed.question !== "string") {
    return jsonResponse({
      error: "Invalid model output",
      type: "parse_error",
      raw: data
    }, 502);
  }
  let q = parsed.question.trim().slice(0, 120);

  if (!q) {
    q = text.trim().slice(0, 120);
  }
  
  if (!q.endsWith("?")) {
    q += "?";
  }
  return jsonResponse({
    questions: [q]
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

  return { question: "" };
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
