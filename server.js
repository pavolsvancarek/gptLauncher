export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return jsonResponse({}, 200);
    }

    try {
      const url = new URL(request.url);

      if (url.pathname === "/ask" && request.method === "POST") {
        return await handleAsk(request, env);
      }
      
      if (url.pathname === "/voice" && request.method === "POST") {
        return await handleVoice(request, env);
      }
      
      if (url.pathname === "/stats" && request.method === "GET") {
        return await handleStats(env);
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

async function handleStats(env) {
  try {
    const [ig, yt] = await Promise.all([
      getIGStats(env),
      getYouTubeStats(env)
    ]);

    return jsonResponse({
      instagram: ig,
      youtube: yt
    });

  } catch (e) {
    return jsonResponse({
      error: e.message || "Stats error"
    }, 500);
  }
}

async function getYouTubeStats(env) {
  const KEY = env.YOUTUBE_API_KEY;
  const CHANNEL = env.YOUTUBE_CHANNEL_ID;

  // 1. subscribers
  const channel = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${CHANNEL}&key=${KEY}`
  ).then(r => r.json());
  if (channel.error) {
    throw new Error(channel.error.message);
  }
  const subscribers =
    parseInt(channel.items?.[0]?.statistics?.subscriberCount || "0");

  // 2. latest videos
  const search = await fetch(
    `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${CHANNEL}&order=date&maxResults=10&type=video&key=${KEY}`
  ).then(r => r.json());

  const ids = search.items
    ?.map(v => v.id.videoId)
    ?.filter(Boolean);

  if (!ids?.length) {
    return { subscribers, last_video_views: null };
  }

  // 3. video details
  const videos = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=${ids.join(",")}&key=${KEY}`
  ).then(r => r.json());

  let lastViews = null;
  const videoMap = Object.fromEntries(
    videos.items.map(v => [v.id, v])
  );
  
  for (const id of ids) {
    const v = videoMap[id];
    const duration = v.contentDetails.duration;
    const seconds = parseDuration(duration);
  
    if (seconds >= 60) {
      lastViews = parseInt(v.statistics.viewCount || "0");
      break;
    }
  }
  
  return {
    subscribers,
    last_video_views: lastViews
  };
}

function parseDuration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);

  const h = parseInt(match?.[1] || 0);
  const m = parseInt(match?.[2] || 0);
  const s = parseInt(match?.[3] || 0);

  return h * 3600 + m * 60 + s;
}

async function getIGStats(env) {
  const IG_ID = env.IG_ID;
  const TOKEN = env.FB_PAGE_TOKEN;

  if (!IG_ID || !TOKEN) {
    throw new Error("Missing IG config");
  }
  
  try {
    // 1. followers
    const profile = await fetch(
      `https://graph.facebook.com/v25.0/${IG_ID}?fields=followers_count&access_token=${TOKEN}`
    ).then(r => r.json());
      console.log("Profile:", JSON.stringify(profile, null, 2));

    if (profile.error) {
      throw new Error(profile.error.message);
    }
    // 2. last post
    const media = await fetch(
      `https://graph.facebook.com/v25.0/${IG_ID}/media?fields=id,media_type&limit=1&access_token=${TOKEN}`
    ).then(r => r.json());
    console.log("IG media:", JSON.stringify(media, null, 2));
    if (media.error) throw new Error(media.error.message);
    
    const mediaId = media.data?.[0]?.id;
    const mediaType = media.data?.[0]?.media_type;

    if (!mediaId) {
      throw new Error("No media found");
    }
    // 3. likes
    const likesRes = await fetch(
      `https://graph.facebook.com/v25.0/${mediaId}?fields=like_count&access_token=${TOKEN}`
    ).then(r => r.json());
    if (likesRes.error) throw new Error(likesRes.error.message);
    console.log("IG likes:", JSON.stringify(likesRes, null, 2));
    let views = null;

    // 4. views (len video/reel)
    if (mediaType === "VIDEO" || mediaType === "REEL") {
      try {
        const viewsRes = await fetch(
          `https://graph.facebook.com/v25.0/${mediaId}/insights?metric=views&access_token=${TOKEN}`
        ).then(r => r.json());
        console.log("IG views:", JSON.stringify(viewsRes, null, 2));
        views = viewsRes.data?.[0]?.values?.[0]?.value ?? null;
      } catch {}
    }

    // 5. reach
    const reachRes = await fetch(
      `https://graph.facebook.com/v25.0/${IG_ID}/insights?metric=reach&period=day&access_token=${TOKEN}`
    ).then(r => r.json());
    if (reachRes.error) throw new Error(reachRes.error.message);
    console.log("IG reach:", JSON.stringify(reachRes, null, 2));
    const values = reachRes.data?.[0]?.values || [];
        
    const todayUTC = new Date().toISOString().slice(0, 10);
    
    const yesterday = getLocalDateString(-1);
    
    const yesterdayReach = values.find(v => {
      const d = new Date(v.end_time)
        .toLocaleString("en-US", { timeZone: "Europe/Bratislava" });
    
      const localDate = new Date(d).toISOString().slice(0, 10);
    
      return localDate === yesterday;
    })?.value ?? null;
    
    return {
      followers: profile.followers_count,
      last_post: {
        likes: likesRes.like_count,
        views
      },
      yesterday_reach: yesterdayReach
    };

  } catch (e) {
    throw new Error(e.message || "IG API error");
  }
}

function getLocalDateString(offsetDays = 0) {
  const now = new Date();

  const local = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Bratislava" })
  );

  local.setDate(local.getDate() + offsetDays);

  return local.toISOString().slice(0, 10);
}

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
    return jsonResponse({ error: "Missing audio file" }, 400);
  }
  
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

  const gptResponse = await askGptFromText(safeTranscript, env);

  if (!gptResponse.ok) {
    return gptResponse;
  }  
  // parse Response -> JSON
  const data = await gptResponse.json();
  
  // pridaj transcript
  return jsonResponse({
    questions: data.questions,
    transcript: safeTranscript
  });
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
                  "Z textu vytvor JEDNU krátku vetu v slovenčine, ktorá vystihuje hlavnú myšlienku. " +
                  "Ak text už je krátky a dáva zmysel, ponechaj ho takmer nezmenený. " +
                  "Ak text znie ako otázka, ponechaj otázku. " +
                  "Ak text znie ako poznámka alebo myšlienka, ponechaj ju ako vetu (nie otázku). " +
                  "Max 120 znakov len ak je text dlhý. " +
                  "Bez vysvetlenia. Vráť JSON {question}."      
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
