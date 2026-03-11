export default {  
  async fetch(request, env) {
    const appKey = request.headers.get("X-APP-KEY");

    if (appKey !== env.APP_KEY) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
    try {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }

      const url = new URL(request.url);

      if (url.pathname !== "/ask") {
        return jsonResponse({ error: "Not found" }, 404);
      }

      const body = await request.json().catch(() => null);
      const text = (body?.text || "").trim();

      if (!text) {
        return jsonResponse({ error: "Missing text" }, 400);
      }

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
    } catch (e) {
      return jsonResponse(
        { error: e?.message || "Server error" },
        500
      );
    }
  }
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
