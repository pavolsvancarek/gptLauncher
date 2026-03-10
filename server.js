import express from "express";

const app = express();
app.use(express.json());

app.post("/ask", async (req, res) => {
  try {
    const text = (req.body.text || "").trim();

    if (!text) {
      return res.status(400).json({ error: "Missing text" });
    }

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
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

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    const jsonText =
      data.output_text ||
      data.output?.[0]?.content?.[0]?.text ||
      "{}";

    const parsed = JSON.parse(jsonText);

    res.json({
      answer: parsed.answer ?? "",
      questions: parsed.questions ?? []
    });
  } catch (e) {
    res.status(500).json({
      error: e.message || "Server error"
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
