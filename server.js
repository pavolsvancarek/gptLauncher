export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return jsonResponse({}, 200);
    }

    const appKey = request.headers.get("X-APP-KEY");
    if (appKey !== env.APP_KEY) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    try {
      const url = new URL(request.url);

      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }

      if (url.pathname === "/ask") {
        return handleAsk(request, env);
      }

      if (url.pathname === "/voice") {
        return handleVoice(request, env);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (e) {
      return jsonResponse({ error: e?.message || "Server error" }, 500);
    }
  }
};

async function handleAsk(request, env) {
  const body = await request.json().catch(() => null);
  const text = (body?.text || "").trim();

  if (!text) {
    return jsonResponse({ error: "Missing text" }, 400);
  }

  return await askGptFromText(text, env);
}

async function handleVoice(request, env) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || typeof file === "string") {
    return jsonResponse({ error: "Missing audio file" }, 400);
  }

  const transcript = await transcribeAudio(file, env);

  if (!transcript.trim()) {
    return jsonResponse({ error: "Empty transcript" }, 400);
  }

  const gptResponse = await askGptFromText(transcript, env);

  const gptJson = await gptResponse.json().catch(() => null);

  if (!gptResponse.ok) {
    return jsonResponse(gptJson || { error: "GPT error" }, gptResponse.status);
  }

  return jsonResponse({
    answer: gptJson?.answer ?? "",
    questions: Array.isArray(gptJson?.questions) ? gptJson.questions : []
  });
}

async function transcribeAudio(file, env) {
  const form = new FormData();
  form.append("file", file, file.name || "audio.m4a");
  form.append("model", "gpt-4o-mini-transcribe");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`
    },
    body: form
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Transcription failed");
  }

  return data?.text || "";
}

async function askGptFromText(text, env) {
  const openAiResponse = await fetch("https://api.openai.com/v1/responses", {
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
                "Vráť len JSON objekt s poľami answer a questions. " +
                "questions nech je pole 5 krátkych relevantných follow up otázok v slovenčine."
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
                items: { type: "string" }
              }
            },
            required: ["answer", "questions"]
          }
        }
      }
    })
  });

  const data = await openAiResponse.json();

  if (!openAiResponse.ok) {
    return jsonResponse(data, openAiResponse.status);
  }

  const jsonText =
    data.output_text ||
    data.output?.[0]?.content?.[0]?.text ||
    "{}";

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = { answer: "", questions: [] };
  }

  return jsonResponse({
    answer: parsed.answer ?? "",
    questions: Array.isArray(parsed.questions) ? parsed.questions : []
  });
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
